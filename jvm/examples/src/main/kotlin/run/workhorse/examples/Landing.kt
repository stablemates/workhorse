// The Kotlin snippets of the landing page (https://workhorse.run). Each `docs:start
// landing-<name>-kotlin` region is one snippet. Each nested object holds one snippet, as each
// module
// of `rust/examples/landing.rs` does, so that two snippets can use the same function name.

package run.workhorse.examples

import com.zaxxer.hikari.HikariDataSource
import jakarta.servlet.DispatcherType
import jakarta.servlet.ServletContext
import jakarta.servlet.http.HttpServletRequest
import java.time.Duration
import java.time.Instant
import java.util.EnumSet
import java.util.UUID
import javax.sql.DataSource
import run.workhorse.Admin
import run.workhorse.AdminAudit
import run.workhorse.BatchOptions
import run.workhorse.BatchSucceeded
import run.workhorse.ConcurrencyPolicyDefinition
import run.workhorse.ConnectionSource
import run.workhorse.DeadLetterQuery
import run.workhorse.Debounce
import run.workhorse.DebounceSchedule
import run.workhorse.Dependencies
import run.workhorse.DependencyPolicy
import run.workhorse.EnqueueOptions
import run.workhorse.EnqueueResult
import run.workhorse.Idempotency
import run.workhorse.Queue
import run.workhorse.RateLimit
import run.workhorse.RateLimitPolicyDefinition
import run.workhorse.ScheduleDefinition
import run.workhorse.ScheduledTask
import run.workhorse.TaskQuery
import run.workhorse.TaskState
import run.workhorse.WorkerProcess
import run.workhorse.dashboard.Dashboard
import run.workhorse.dashboard.DashboardAuthorization
import run.workhorse.kotlin.WorkerScope
import run.workhorse.kotlin.cancelSuspend
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.kotlin.healthSuspend
import run.workhorse.kotlin.listDeadLettersSuspend
import run.workhorse.kotlin.listTasksSuspend
import run.workhorse.kotlin.listWorkersSuspend
import run.workhorse.kotlin.redriveSuspend
import run.workhorse.kotlin.sendSignalSuspend
import run.workhorse.kotlin.setWorkerPausedSuspend
import run.workhorse.kotlin.syncConcurrencyPoliciesSuspend
import run.workhorse.kotlin.syncRateLimitPoliciesSuspend
import run.workhorse.kotlin.syncSchedulesSuspend
import run.workhorse.kotlin.workhorseWorker

/** The Kotlin snippets of the landing page. */
object LandingKotlin {
  /** The first snippet of the page: enqueue a task and run a worker. */
  object HeroExample {
    // docs:start landing-hero-kotlin
    suspend fun run(dataSource: DataSource) {
      Queue(ConnectionSource.of(dataSource))
        .enqueueSuspend("email.welcome", mapOf("to" to "ada@example.com"))

      val worker =
        workhorseWorker(dataSource) {
          concurrency = 4
          handle<Map<String, Any?>>("email.welcome") { _, payload ->
            mapOf("deliveredTo" to payload["to"])
          }
        }
      WorkerProcess.runWorkerProcess(worker)
    }
    // docs:end
  }

  /** Enqueue in the transaction of the application. */
  object EnqueueExample {
    // docs:start landing-enqueue-kotlin
    suspend fun createOrder(dataSource: DataSource, orderId: String, total: Long) {
      dataSource.connection.use { connection ->
        connection.autoCommit = false
        connection.prepareStatement("INSERT INTO orders (id, total) VALUES (?, ?)").use { insert ->
          insert.setString(1, orderId)
          insert.setLong(2, total)
          insert.executeUpdate()
        }

        // Same transaction: the task exists exactly when the order does.
        Queue(ConnectionSource.of(dataSource))
          .enqueueSuspend("order.confirm", mapOf("orderId" to orderId), connection = connection)
        connection.commit()
      }
    }
    // docs:end
  }

  /** Checkpoints. */
  object CheckpointsExample {
    // docs:start landing-checkpoints-kotlin
    fun chargeCard(amount: Any?): Map<String, Any?> = mapOf("id" to "ch_$amount")

    fun renderInvoice(chargeId: Any?): Map<String, Any?> = mapOf("chargeId" to chargeId)

    fun WorkerScope.registerInvoice() {
      handle<Map<String, Any?>>("invoice.issue") { context, invoice ->
        // After Workhorse stores a checkpoint result, later runs return it.
        val charge =
          context.checkpoint<Map<String, Any?>>("charge") { chargeCard(invoice["amount"]) }

        val pdf = context.checkpoint<Map<String, Any?>>("render") { renderInvoice(charge["id"]) }

        println("email ${invoice["email"]} $pdf")
        mapOf("chargeId" to charge["id"])
      }
    }
    // docs:end
  }

  /** A durable sleep. */
  object SleepExample {
    // docs:start landing-sleep-kotlin
    fun placeOrder(payload: Map<String, Any?>): Map<String, Any?> =
      mapOf("orderId" to payload["orderId"])

    fun WorkerScope.registerSettlement() {
      handle<Map<String, Any?>>("order.settle") { context, payload ->
        val order = context.checkpoint<Map<String, Any?>>("place") { placeOrder(payload) }

        // Slot released here. The process can restart, deploy, or die.
        context.sleep("settlement-window", Duration.ofHours(1))

        mapOf("settled" to order["orderId"])
      }
    }
    // docs:end
  }

  /** Deadlines, timeouts, and retries. */
  object RetriesExample {
    // docs:start landing-retries-kotlin
    suspend fun remind(queue: Queue, matchId: String, kickoff: Instant): EnqueueResult =
      queue.enqueueSuspend(
        "match.reminder",
        mapOf("matchId" to matchId),
        EnqueueOptions.builder()
          // Pointless after kickoff, whatever else happens.
          .deadline(kickoff)
          // Any single attempt is stuck after 30 seconds.
          .executionTimeout(Duration.ofSeconds(30))
          .maxAttempts(5)
          .retryPolicy(
            mapOf(
              "type" to "exponential",
              "initialDelayMs" to 1_000,
              "multiplier" to 2,
              "maxDelayMs" to 60_000,
            ),
          )
          .build(),
      )
    // docs:end
  }

  /** Enqueue idempotency. */
  object IdempotencyExample {
    // docs:start landing-idempotency-kotlin
    // A retried webhook gets the same taskId back instead of a second capture.
    suspend fun capture(queue: Queue): EnqueueResult =
      queue.enqueueSuspend(
        "invoice.capture",
        mapOf("invoiceId" to "inv-1"),
        EnqueueOptions.builder()
          .queue("billing")
          .idempotency(Idempotency("capture:inv-1", "tenant-42", Duration.ofDays(1)))
          .build(),
      )
    // docs:end
  }

  /** Schedules. */
  object SchedulesExample {
    // docs:start landing-schedules-kotlin
    suspend fun run(dataSource: DataSource) {
      // Run on every deployment with the complete list.
      val task = ScheduledTask.of("invoices.generate", emptyMap<String, Any?>())
      val schedule = ScheduleDefinition("nightly-invoice-run", "0 2 * * *", task)
      Queue(ConnectionSource.of(dataSource))
        .syncSchedulesSuspend("billing", listOf(schedule), prune = true)

      // Any worker in the namespace fires due schedules itself.
      val worker = workhorseWorker(dataSource) { scheduleNamespaces = listOf("billing") }
      WorkerProcess.runWorkerProcess(worker)
    }
    // docs:end
  }

  /** Concurrency and rate limits. */
  object FlowControlExample {
    // docs:start landing-flow-control-kotlin
    suspend fun configure(queue: Queue, messageId: String, tenantId: String) {
      // At most 20 mail tasks active; at most 2 per tenant.
      val mail = ConcurrencyPolicyDefinition("mail", 20, 2)
      queue.syncConcurrencyPoliciesSuspend("workers", listOf(mail), prune = false)

      val provider =
        RateLimitPolicyDefinition("provider-api", RateLimit(100, Duration.ofSeconds(1), 200))
      queue.syncRateLimitPoliciesSuspend("workers", listOf(provider), prune = false)

      queue.enqueueSuspend(
        "mail.send",
        mapOf("messageId" to messageId),
        EnqueueOptions.builder().queue("mail").concurrencyKey("tenant:$tenantId").build(),
      )
    }
    // docs:end
  }

  /** Dependencies and child tasks. */
  object DependenciesExample {
    // docs:start landing-dependencies-kotlin
    suspend fun confirm(queue: Queue, orderId: String) {
      val order = mapOf("orderId" to orderId)
      val inventory = queue.enqueueSuspend("inventory.reserve", order)

      val dependencies =
        Dependencies(
          listOf(inventory.taskId()),
          DependencyPolicy.RELEASE,
          DependencyPolicy.CANCEL,
          DependencyPolicy.CANCEL,
        )
      queue.enqueueSuspend(
        "order.confirm",
        order,
        EnqueueOptions.builder().dependencies(dependencies).build(),
      )
    }

    fun WorkerScope.registerFulfillment() {
      handle<Map<String, Any?>>("order.fulfill") { context, order ->
        val options = EnqueueOptions.builder().queue("payments").build()
        val capture = mapOf("orderId" to order["id"])
        val receipt =
          context.runChild<Map<String, Any?>>("charge", "payment.capture", capture, options)
        mapOf("receipt" to receipt)
      }
    }
    // docs:end
  }

  /** Debounce. */
  object CoalescingExample {
    // docs:start landing-coalescing-kotlin
    suspend fun reindex(queue: Queue, documentId: String, quietPeriod: Duration) {
      val debounce = Debounce(documentId, quietPeriod, DebounceSchedule.RESET, "search-index")
      val options = EnqueueOptions.builder().debounce(debounce).build()
      val first =
        queue.enqueueSuspend(
          "search.reindex",
          mapOf("documentId" to documentId, "revision" to 1),
          options,
        )
      val latest =
        queue.enqueueSuspend(
          "search.reindex",
          mapOf("documentId" to documentId, "revision" to 2),
          options,
        )
      println("${first.outcome()} ${latest.outcome()}")
    }
    // docs:end
  }

  /** Signals and human waits. */
  object ExternalWaitsExample {
    // docs:start landing-external-waits-kotlin
    fun WorkerScope.registerRelease() {
      handle<Map<String, Any?>>("release.publish") { context, release ->
        val scan = context.waitForSignal<Any?>("security-scan")

        val request = mapOf("releaseId" to release["id"], "scan" to scan)
        val review = context.waitForHuman<Map<String, Any?>>("release-approval", request)

        mapOf("published" to review["approved"])
      }
    }

    suspend fun deliverScan(queue: Queue, taskId: UUID, result: Any?, deliveryId: String) {
      queue.sendSignalSuspend(
        taskId,
        "security-scan",
        result,
        idempotencyKey = deliveryId,
        requestedBy = "security-scanner",
      )
    }
    // docs:end
  }

  /** Batch handlers. */
  object BatchHandlersExample {
    // docs:start landing-batch-handlers-kotlin
    fun WorkerScope.registerEmailBatch(batchSize: Int, linger: Duration) {
      handleBatch<Any?>("email.send", BatchOptions(batchSize, linger)) { items ->
        items.map { item -> BatchSucceeded(item.payload()) }
      }
    }
    // docs:end
  }

  /** Cancellation. */
  object CancellationExample {
    // docs:start landing-cancellation-kotlin
    fun WorkerScope.registerExport() {
      handle<List<Any?>>("rows.export") { context, rows ->
        for (row in rows) {
          context.cancellation.throwIfCancelled()
          println("upload $row")
        }
        mapOf("stopped" to false)
      }
    }

    suspend fun cancelExport(queue: Queue, taskId: UUID) {
      queue.cancelSuspend(
        taskId,
        requestedBy = "operator@example.com",
        reason = "customer withdrew the request",
      )
    }
    // docs:end
  }

  /** Dead letters. */
  object DeadLettersExample {
    // docs:start landing-dead-letters-kotlin
    suspend fun redriveBilling(admin: Admin) {
      val query =
        DeadLetterQuery.builder().queue("billing").errorName("CardDeclined").limit(100).build()
      val page = admin.listDeadLettersSuspend(query)

      for (failure in page.items()) {
        val audit =
          AdminAudit(
            "operator@example.com",
            "provider incident resolved",
            "incident-2026-08-03:${failure.taskId()}",
          )
        admin.redriveSuspend(failure.taskId(), audit)
      }
    }
    // docs:end
  }

  /** The dashboard. */
  object OperateDashboardExample {
    // docs:start landing-operate-dashboard-kotlin
    fun adminSession(request: HttpServletRequest): String? = request.getHeader("X-Admin")

    fun mount(dataSource: DataSource, servletContext: ServletContext) {
      val dashboard =
        Dashboard.builder(ConnectionSource.of(dataSource)) { request ->
            val actor = adminSession(request)
            if (actor != null) DashboardAuthorization.principal(actor)
            else DashboardAuthorization.deny()
          }
          .path("/workhorse")
          .build()
      servletContext
        .addFilter("workhorse-dashboard", dashboard)
        .addMappingForUrlPatterns(EnumSet.of(DispatcherType.REQUEST), false, "/workhorse/*")
    }
    // docs:end
  }

  /** Queue health and the task list. */
  object OperateHealthExample {
    // docs:start landing-operate-health-kotlin
    suspend fun inspect(dataSource: DataSource) {
      val health = Queue(ConnectionSource.of(dataSource)).healthSuspend().snapshot()
      val status = health["status"] as Map<*, *>
      if (status["level"] != "healthy") println(status["reasons"])

      // Cross-state listing on a dedicated projection: reading it never slows dispatch down.
      val query =
        TaskQuery.builder().states(listOf(TaskState.ACTIVE, TaskState.SCHEDULED)).limit(100).build()
      val live = Admin(ConnectionSource.of(dataSource)).listTasksSuspend(query)
      println(live.items().size)
    }
    // docs:end
  }

  /** The worker fleet. */
  object OperateFleetExample {
    // docs:start landing-operate-fleet-kotlin
    suspend fun pauseBilling(dataSource: DataSource) {
      val admin = Admin(ConnectionSource.of(dataSource))
      for (entry in admin.listWorkersSuspend()) {
        if (entry.queue() != "billing") continue

        val audit =
          AdminAudit(
            "operator@example.com",
            "rolling deploy",
            "deploy-2026-08-23:${entry.workerId()}",
          )
        admin.setWorkerPausedSuspend(entry.workerId(), true, audit)
      }
    }
    // docs:end
  }

  /** A worker process for deployment. */
  object DeployExample {
    // docs:start landing-deploy-kotlin
    fun run() {
      // The application supplies the pool. JDBC_DATABASE_URL holds a jdbc:postgresql: URL.
      val dataSource =
        HikariDataSource().apply {
          jdbcUrl = System.getenv("JDBC_DATABASE_URL")
          maximumPoolSize = 10
        }

      val worker =
        workhorseWorker(dataSource) {
          queues = listOf("email")
          concurrency = 8
          // Bounded graceful drain on SIGTERM.
          shutdownGrace = Duration.ofSeconds(25)
          handle<Map<String, Any?>>("email.send") { _, email -> mapOf("sent" to email["to"]) }
        }
      WorkerProcess.runWorkerProcess(worker)
    }
    // docs:end
  }
}
