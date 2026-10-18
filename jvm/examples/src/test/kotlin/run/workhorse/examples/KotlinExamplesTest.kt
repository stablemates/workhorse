package run.workhorse.examples

import java.sql.SQLException
import java.time.Duration
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.Admin
import run.workhorse.ConnectionSource
import run.workhorse.Queue
import run.workhorse.TaskState
import run.workhorse.testing.ScratchDatabase

/** Runs each Kotlin snippet that needs no servlet container and no child JVM. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class KotlinExamplesTest {
  private val dataSource = ExampleDatabase.dataSource()
  private val queue = Queue(ConnectionSource.of(dataSource))

  companion object {
    @JvmStatic
    @BeforeAll
    fun accountTable() {
      ExampleDatabase.createAccountTable()
    }
  }

  @Test
  fun theJdbcTransactionCommitsTheAccountAndTheTaskTogether() = runBlocking {
    val id = "kotlin-${UUID.randomUUID()}"
    createAccount(dataSource, queue, id, "person@example.com")
    assertEquals(1, ExampleDatabase.accounts(id))
    assertEquals(1, ExampleDatabase.tasks("account.created", "accountId", id).size)
  }

  @Test
  fun theJdbcTransactionRollsBackTheTaskWithTheAccount() {
    val id = "kotlin-${UUID.randomUUID()}"
    // The commit fails after the insert and the enqueue ran on the connection.
    assertThrows(SQLException::class.java) {
      runBlocking { createAccount(FailingCommitDataSource(), queue, id, "person@example.com") }
    }
    assertEquals(0, ExampleDatabase.accounts(id))
    assertEquals(0, ExampleDatabase.tasks("account.created", "accountId", id).size)
  }

  @Test
  fun theShortTransactionFormCommitsOnTheCallersConnection() = runBlocking {
    val id = "kotlin-${UUID.randomUUID()}"
    dataSource.connection.use { connection ->
      enqueueInTransaction(connection, queue, id, "person@example.com")
    }
    assertEquals(1, ExampleDatabase.accounts(id))
    assertEquals(1, ExampleDatabase.tasks("account.created", "accountId", id).size)
  }

  @Test
  fun anEnqueueWithARunTimeIsScheduledOnItsQueue() = runBlocking {
    val invoiceId = "kotlin-${UUID.randomUUID()}"
    enqueueNowOrLater(queue, invoiceId, Instant.now().plus(3, ChronoUnit.DAYS))
    val reminder = ExampleDatabase.task("invoice.remind", "invoiceId", invoiceId)
    assertEquals("billing", reminder.queue())
    assertEquals(TaskState.SCHEDULED, reminder.state())
    assertFalse(ExampleDatabase.tasks("email.send", "to", "person@example.com").isEmpty())
  }

  @Test
  fun theEnqueueOptionsReachTheTask() = runBlocking {
    val endOfMonth = Instant.now().plus(30, ChronoUnit.DAYS).truncatedTo(ChronoUnit.SECONDS)
    enqueueWithOptions(queue, endOfMonth)
    val report =
      ExampleDatabase.detail(ExampleDatabase.tasks("report.generate", "month", "2026-08").last())
    assertEquals("reports", report.queue())
    assertEquals(listOf("tenant:acme"), report.tags())
    assertEquals("acme", report.concurrencyKey())
    assertEquals(10, report.priority())
    assertEquals(5, report.maxAttempts())
    assertEquals(endOfMonth, report.deadlineAt())
    assertEquals(Duration.ofMinutes(2), report.executionTimeout())
  }

  @Test
  fun enqueueManyReturnsOneResultForEachRecipientInOrder() = runBlocking {
    val first = "${UUID.randomUUID()}@example.com"
    val second = "${UUID.randomUUID()}@example.com"
    val results = enqueueMany(queue, listOf(Recipient(first), Recipient(second)))
    assertEquals(2, results.size)
    assertEquals(results[0].taskId(), ExampleDatabase.task("email.digest", "to", first).id())
    assertEquals(results[1].taskId(), ExampleDatabase.task("email.digest", "to", second).id())
    assertEquals("mail", ExampleDatabase.detail(results[0].taskId()).queue())
  }

  @Test
  fun pauseAndResumeLeaveTheQueueRunning() = runBlocking {
    val requestId = "kotlin-${UUID.randomUUID()}"
    pauseAndResume(
      Admin(ConnectionSource.of(dataSource)),
      "dana",
      "maintenance",
      requestId,
      "$requestId-resume",
    )
  }

  @Test
  fun theSchemaCheckAcceptsTheInstalledSchema() = runBlocking {
    checkSchema(dataSource)
    Unit
  }

  @Test
  fun theWorkerOptionsReachTheWorker() {
    workerWithOptions(dataSource, 3, Duration.ofSeconds(45)).use { worker ->
      assertEquals("email-worker-1", worker.workerId())
      assertEquals(3, worker.concurrency())
      assertEquals(listOf("email", "billing"), worker.queues())
    }
  }

  @Test
  fun theReadmeSnippetRunsOneTask() {
    val taskId = runReadmeExample(arrayOf(ExampleDatabase.jdbcUrl()))
    val task = ExampleDatabase.detail(taskId)
    assertEquals(TaskState.SUCCEEDED, task.state())
    assertEquals(mapOf("echo" to mapOf("packaged" to true)), task.result())
  }
}
