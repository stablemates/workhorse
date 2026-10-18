package run.workhorse.kotlin.spring

import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import java.sql.Connection
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference
import javax.sql.DataSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.extension.ExtendWith
import org.springframework.boot.autoconfigure.AutoConfigurations
import org.springframework.boot.jackson.autoconfigure.JacksonAutoConfiguration
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.annotation.EnableTransactionManagement
import org.springframework.transaction.annotation.Propagation
import org.springframework.transaction.annotation.Transactional
import run.workhorse.Admin
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.kotlin.getTaskSuspend
import run.workhorse.spring.WorkhorseAutoConfiguration
import run.workhorse.testing.ScratchDataSource
import run.workhorse.testing.ScratchDatabase

/**
 * A suspend wrapper inside a Kotlin `@Transactional` service joins that transaction. The context
 * has the starter. ADR 0103, "Amendment: a Kotlin suspend wrapper joins the caller's Spring
 * transaction", states the rule. The service is blocking and enters coroutine code with
 * `runBlocking`, so the wrapper runs on the thread that holds the transaction.
 */
@ExtendWith(ScratchDatabase::class)
class SuspendTransactionTest {
  @Test
  fun aSuspendEnqueueThatRollsBackLeavesNoTask() {
    val queueName = unique("kotlin-rollback")
    database().withUserConfiguration(Transactions::class.java).run { context ->
      val orders = context.getBean(Orders::class.java)
      assertThrows<IllegalStateException> { orders.placeThenFail(queueName) }
      assertNotNull(orders.seenInside(), "the enqueue ran")
      assertEquals(0L, ordersIn(queueName), "no order after the rollback")
      assertEquals(0L, tasksIn(queueName), "no task after the rollback")
    }
  }

  @Test
  fun aSuspendEnqueueThatCommitsIsInvisibleUntilTheCommit() {
    val queueName = unique("kotlin-commit")
    database().withUserConfiguration(Transactions::class.java).run { context ->
      val orders = context.getBean(Orders::class.java)
      val taskId = orders.place(queueName)
      assertFalse(orders.visibleInside(), "invisible to another connection before the commit")
      assertTrue(orders.adminSawInside(), "the Admin wrapper reads the task inside the transaction")
      assertTrue(stored(taskId), "visible after the commit")
      assertEquals(1L, ordersIn(queueName), "the order commits with the task")
    }
  }

  @Test
  fun aSuspendEnqueueInASupportsScopeCommitsWhenThePoolTurnsAutocommitOff() {
    val queueName = unique("kotlin-supports")
    runner()
      .withBean(DataSource::class.java, { ScratchDataSource(false) })
      .withUserConfiguration(Transactions::class.java)
      .run { context ->
        val orders = context.getBean(Orders::class.java)
        val taskId = orders.placeWithSupports(queueName)
        assertTrue(orders.visibleInside(), "committed in autocommit inside the scope")
        assertTrue(stored(taskId))
      }
  }

  @Test
  fun aSuspendEnqueueInANotSupportedScopeCommitsWhenThePoolTurnsAutocommitOff() {
    val queueName = unique("kotlin-not-supported")
    runner()
      .withBean(DataSource::class.java, { ScratchDataSource(false) })
      .withUserConfiguration(Transactions::class.java)
      .run { context ->
        val orders = context.getBean(Orders::class.java)
        val taskId = orders.placeWithNotSupported(queueName)
        assertTrue(orders.visibleInside(), "committed in autocommit inside the scope")
        assertTrue(stored(taskId))
      }
  }

  @Test
  fun aCancellationDuringTheEnqueueDoesNotInterruptTheTransaction() {
    val queueName = unique("kotlin-cancel")
    val probe = CancelProbe()
    runner()
      .withBean(DataSource::class.java, { CancellingDataSource(ScratchDataSource(true), probe) })
      .withUserConfiguration(Transactions::class.java)
      .run { context ->
        val orders = context.getBean(Orders::class.java)
        orders.placeThroughACancellation(queueName, probe)
        assertEquals(listOf(false), probe.interruptedDuringEnqueue, "no interrupt in the statement")
        assertTrue(orders.cancelledInside(), "the caller got the cancellation after the enqueue")
        assertEquals(1L, tasksIn(queueName), "the enqueue committed with the transaction")
        assertEquals(1L, ordersIn(queueName), "the transaction's connection stayed usable")
      }
  }

  /** The Job to cancel during the enqueue statement, and the interrupt state that it saw. */
  class CancelProbe {
    val job = AtomicReference<Job?>()
    val interruptedDuringEnqueue = CopyOnWriteArrayList<Boolean>()
  }

  /**
   * A source whose connections cancel [probe]'s Job when the enqueue statement starts. The
   * cancellation runs on the thread of the statement. The source then records whether that thread
   * has an interrupt.
   */
  private class CancellingDataSource(
    private val source: ScratchDataSource,
    private val probe: CancelProbe,
  ) : DataSource by source {
    override fun getConnection(): Connection {
      val connection = source.connection
      return Proxy.newProxyInstance(
        Connection::class.java.classLoader,
        arrayOf(Connection::class.java),
      ) { _, method, arguments ->
        val sql = arguments?.firstOrNull()
        if (method.name == "prepareStatement" && sql is String && sql.contains("enqueue_many_v1")) {
          probe.job.getAndSet(null)?.let { job ->
            job.cancel()
            probe.interruptedDuringEnqueue.add(Thread.currentThread().isInterrupted)
          }
        }
        try {
          method.invoke(connection, *(arguments ?: emptyArray()))
        } catch (error: InvocationTargetException) {
          throw error.cause ?: error
        }
      } as Connection
    }
  }

  @Configuration(proxyBeanMethods = false)
  @EnableTransactionManagement
  open class Transactions {
    @Bean
    open fun transactionManager(dataSource: DataSource): PlatformTransactionManager =
      DataSourceTransactionManager(dataSource)

    @Bean
    open fun orders(queue: Queue, admin: Admin, dataSource: DataSource): Orders =
      Orders(queue, admin, dataSource)
  }

  /**
   * A Kotlin application service that inserts an order and enqueues a task in one transaction. A
   * CGLIB proxy wraps it, so the class and its transactional methods are open, and the test reads
   * the state through methods.
   */
  open class Orders(private val queue: Queue, private val admin: Admin, dataSource: DataSource) {
    private val jdbc = JdbcTemplate(dataSource)
    private val seenInside = AtomicReference<UUID?>()
    @Volatile private var visibleInside = false
    @Volatile private var adminSawInside = false
    @Volatile private var cancelledInside = false

    init {
      jdbc.execute("CREATE TABLE IF NOT EXISTS kotlin_order (queue_name text NOT NULL)")
    }

    @Transactional
    open fun placeThenFail(queueName: String) {
      seenInside.set(order(queueName))
      throw IllegalStateException("the order fails after the enqueue")
    }

    @Transactional
    open fun place(queueName: String): UUID {
      val taskId = order(queueName)
      visibleInside = stored(taskId)
      adminSawInside = runBlocking { admin.getTaskSuspend(taskId) } != null
      return taskId
    }

    @Transactional(propagation = Propagation.SUPPORTS)
    open fun placeWithSupports(queueName: String): UUID {
      // Two enqueues: the second one reuses the connection that the first one bound.
      enqueue(queueName)
      return enqueue(queueName).also { visibleInside = stored(it) }
    }

    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    open fun placeWithNotSupported(queueName: String): UUID {
      enqueue(queueName)
      return enqueue(queueName).also { visibleInside = stored(it) }
    }

    @Transactional
    open fun placeThroughACancellation(queueName: String, probe: CancelProbe) {
      try {
        runBlocking {
          probe.job.set(coroutineContext[Job])
          try {
            enqueueSuspend(queueName)
          } catch (cancelled: CancellationException) {
            cancelledInside = true
            throw cancelled
          }
        }
      } catch (_: CancellationException) {
        // The order continues in the same transaction after the cancelled coroutine.
      }
      jdbc.update("INSERT INTO kotlin_order (queue_name) VALUES (?)", queueName)
    }

    open fun seenInside(): UUID? = seenInside.get()

    open fun visibleInside(): Boolean = visibleInside

    open fun adminSawInside(): Boolean = adminSawInside

    open fun cancelledInside(): Boolean = cancelledInside

    private fun order(queueName: String): UUID {
      jdbc.update("INSERT INTO kotlin_order (queue_name) VALUES (?)", queueName)
      return enqueue(queueName)
    }

    private fun enqueue(queueName: String): UUID = runBlocking { enqueueSuspend(queueName) }

    private suspend fun enqueueSuspend(queueName: String): UUID =
      queue
        .enqueueSuspend(
          "order.receipt",
          mapOf("order" to 7),
          EnqueueOptions.builder().queue(queueName).build(),
        )
        .taskId
  }

  private companion object {
    /** A context with the starter and Jackson, and no DataSource. */
    fun runner(): ApplicationContextRunner =
      ApplicationContextRunner()
        .withConfiguration(
          AutoConfigurations.of(
            JacksonAutoConfiguration::class.java,
            WorkhorseAutoConfiguration::class.java,
          ),
        )

    /** A context on the scratch database. */
    fun database(): ApplicationContextRunner =
      runner().withBean(DataSource::class.java, { ScratchDataSource(true) })

    /** A queue name that no other test uses. */
    fun unique(prefix: String): String = "$prefix-${UUID.randomUUID()}"

    fun stored(taskId: UUID): Boolean =
      count("SELECT count(*) FROM workhorse.task WHERE id = ?", taskId) == 1L

    fun tasksIn(queueName: String): Long =
      count("SELECT count(*) FROM workhorse.task WHERE queue_name = ?", queueName)

    fun ordersIn(queueName: String): Long =
      count("SELECT count(*) FROM kotlin_order WHERE queue_name = ?", queueName)

    fun count(sql: String, argument: Any): Long =
      ScratchDatabase.connect().use { connection ->
        connection.prepareStatement(sql).use { statement ->
          statement.setObject(1, argument)
          statement.executeQuery().use { result ->
            result.next()
            result.getLong(1)
          }
        }
      }
  }
}
