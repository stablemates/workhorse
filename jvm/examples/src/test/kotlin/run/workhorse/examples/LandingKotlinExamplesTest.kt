package run.workhorse.examples

import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletRequestWrapper
import java.time.Duration
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.Admin
import run.workhorse.DeadLetterQuery
import run.workhorse.EnqueueOptions
import run.workhorse.EnqueueOutcome
import run.workhorse.HumanWaitQuery
import run.workhorse.RateLimit
import run.workhorse.SignalWaitQuery
import run.workhorse.TaskState
import run.workhorse.Worker
import run.workhorse.kotlin.workhorseWorker
import run.workhorse.testing.ScratchDatabase

/**
 * Runs each Kotlin snippet of the landing page that does not run until the process ends.
 * [LandingProcessExamplesTest] runs the others.
 */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 180, unit = TimeUnit.SECONDS)
class LandingKotlinExamplesTest {
  companion object {
    private var database: LandingDatabase? = null

    @JvmStatic
    @BeforeAll
    fun createDatabase() {
      database = LandingDatabase.create("landing-kotlin")
    }

    @JvmStatic
    @AfterAll
    fun dropDatabase() {
      database?.close()
    }
  }

  /** The error of the declined card in the dead letter snippet. */
  class CardDeclined : Exception("card declined")

  private val db: LandingDatabase
    get() = checkNotNull(database) { "the database is not created" }

  /** A worker for `runOnce` on the database, without the worker registry. */
  private fun worker(vararg names: String, configure: run.workhorse.kotlin.WorkerScope.() -> Unit) =
    workhorseWorker(db.dataSource()) {
      disableRegistry = true
      if (names.isNotEmpty()) queues = names.toList()
      configure()
    }

  @Test
  fun theOrderAndItsTaskCommitTogether() = runBlocking {
    val orderId = "kotlin-${UUID.randomUUID()}"
    LandingKotlin.EnqueueExample.createOrder(db.dataSource(), orderId, 4200)
    assertEquals(1, db.orders(orderId))
    assertEquals(1, db.tasks("order.confirm", "orderId", orderId).size)
  }

  @Test
  fun theInvoiceHandlerStoresBothCheckpoints() {
    val taskId =
      db
        .queue()
        .enqueue("invoice.issue", mapOf("amount" to 4200, "email" to "ada@example.com"))
        .taskId()
    worker { with(LandingKotlin.CheckpointsExample) { registerInvoice() } }
      .use { db.runUntil(it, taskId, TaskState.SUCCEEDED) }
    assertEquals(mapOf("chargeId" to "ch_4200"), db.detail(taskId).result())
    assertEquals(2, db.admin().listCheckpoints(taskId).size)
  }

  @Test
  fun theSettlementSleepsAfterItsCheckpoint() {
    val orderId = "kotlin-${UUID.randomUUID()}"
    val taskId = db.queue().enqueue("order.settle", mapOf("orderId" to orderId)).taskId()
    worker { with(LandingKotlin.SleepExample) { registerSettlement() } }
      .use { db.runUntil(it, taskId, TaskState.SCHEDULED) }
    assertEquals(
      mapOf("orderId" to orderId),
      db.admin().getCheckpoint(taskId, "place").orElseThrow().value(),
    )
    assertEquals(
      Duration.ofHours(1),
      db.admin().getWait(taskId, "settlement-window").orElseThrow().duration(),
    )
  }

  @Test
  fun theReminderCarriesItsDeadlineTimeoutAndRetryPolicy() = runBlocking {
    val kickoff = Instant.now().plus(2, ChronoUnit.DAYS).truncatedTo(ChronoUnit.SECONDS)
    val result = LandingKotlin.RetriesExample.remind(db.queue(), "match-1", kickoff)
    val task = db.detail(result.taskId())
    assertEquals(kickoff, task.deadlineAt())
    assertEquals(Duration.ofSeconds(30), task.executionTimeout())
    assertEquals(5, task.maxAttempts())
    assertEquals("exponential", task.retryPolicy()?.get("type"))
    assertEquals(60_000L, task.retryPolicy()?.get("maxDelayMs"))
  }

  @Test
  fun aSecondCaptureReplaysTheFirstTask() = runBlocking {
    val first = LandingKotlin.IdempotencyExample.capture(db.queue())
    val second = LandingKotlin.IdempotencyExample.capture(db.queue())
    assertEquals(first.taskId(), second.taskId())
    assertEquals(EnqueueOutcome.REPLAYED, second.outcome())
    assertEquals("billing", db.detail(first.taskId()).queue())
  }

  @Test
  fun thePoliciesAndTheMailTaskReachTheDatabase() = runBlocking {
    val messageId = "kotlin-${UUID.randomUUID()}"
    val queue = db.queue()
    LandingKotlin.FlowControlExample.configure(queue, messageId, "acme")

    val mail = queue.listConcurrencyPolicies(listOf("mail")).first()
    assertEquals("workers", mail.namespace())
    assertEquals(20, mail.maxActive())
    assertEquals(2, mail.maxActivePerKey())
    val provider = queue.listRateLimitPolicies(listOf("provider-api")).first()
    assertEquals(RateLimit(100, Duration.ofSeconds(1), 200), provider.rate())

    val task = db.detail(db.tasks("mail.send", "messageId", messageId).first())
    assertEquals("mail", task.queue())
    assertEquals("tenant:acme", task.concurrencyKey())
  }

  @Test
  fun theConfirmationWaitsForTheReservation() = runBlocking {
    val orderId = "kotlin-${UUID.randomUUID()}"
    LandingKotlin.DependenciesExample.confirm(db.queue(), orderId)
    val inventory = db.tasks("inventory.reserve", "orderId", orderId).first()
    val confirm = db.detail(db.tasks("order.confirm", "orderId", orderId).first())
    assertEquals(listOf(inventory), confirm.prerequisiteTaskIds())
    assertEquals(TaskState.BLOCKED, confirm.state())
  }

  @Test
  fun theFulfillmentReturnsTheReceiptOfItsChild() {
    val orderId = "kotlin-${UUID.randomUUID()}"
    val taskId = db.queue().enqueue("order.fulfill", mapOf("id" to orderId)).taskId()
    worker("default", "payments") {
        handle<Map<String, Any?>>("payment.capture") { _, capture ->
          mapOf("captured" to capture["orderId"])
        }
        with(LandingKotlin.DependenciesExample) { registerFulfillment() }
      }
      .use { db.runUntil(it, taskId, TaskState.SUCCEEDED) }
    assertEquals(
      mapOf("receipt" to mapOf("captured" to orderId)),
      db.detail(taskId).result(),
    )
  }

  @Test
  fun theSecondReindexReplacesTheFirst() {
    val documentId = "kotlin-${UUID.randomUUID()}"
    val lines = LandingDatabase.standardOutput {
      runBlocking {
        LandingKotlin.CoalescingExample.reindex(db.queue(), documentId, Duration.ofMinutes(5))
      }
    }
    assertEquals(listOf("ACCEPTED REPLACED"), lines)
    val tasks = db.tasks("search.reindex", "documentId", documentId)
    assertEquals(1, tasks.size)
    assertEquals(
      mapOf("documentId" to documentId, "revision" to 2L),
      db.detail(tasks[0]).payload(),
    )
  }

  @Test
  fun theReleasePublishesAfterTheScanAndTheApproval() {
    val queue = db.queue()
    val admin = db.admin()
    val taskId = queue.enqueue("release.publish", mapOf("id" to "release-kotlin")).taskId()
    worker { with(LandingKotlin.ExternalWaitsExample) { registerRelease() } }
      .use { worker ->
        LandingDatabase.runUntil(worker) {
          admin.listSignalWaits(SignalWaitQuery.defaults()).items().any { it.taskId() == taskId }
        }
        runBlocking {
          LandingKotlin.ExternalWaitsExample.deliverScan(
            queue,
            taskId,
            mapOf("clean" to true),
            "scan-delivery-kotlin",
          )
        }
        LandingDatabase.runUntil(worker) {
          admin.listHumanWaits(HumanWaitQuery.defaults()).items().any { it.taskId() == taskId }
        }
        assertEquals(
          mapOf("releaseId" to "release-kotlin", "scan" to mapOf("clean" to true)),
          admin
            .listHumanWaits(HumanWaitQuery.defaults())
            .items()
            .first { it.taskId() == taskId }
            .context(),
        )
        queue.completeHumanWait(
          taskId,
          "release-approval",
          mapOf("approved" to true),
          "approval-kotlin",
          "dana",
        )
        db.runUntil(worker, taskId, TaskState.SUCCEEDED)
      }
    assertEquals(mapOf("published" to true), db.detail(taskId).result())
  }

  @Test
  fun theBatchHandlerReturnsEachPayload() {
    val queue = db.queue()
    val first = queue.enqueue("email.send", mapOf("to" to "ada@example.com")).taskId()
    val second = queue.enqueue("email.send", mapOf("to" to "grace@example.com")).taskId()
    worker {
      concurrency = 10
      with(LandingKotlin.BatchHandlersExample) {
        registerEmailBatch(10, Duration.ofMillis(100))
      }
    }
      .use { worker ->
        LandingDatabase.runUntil(worker) {
          db.detail(first).state() == TaskState.SUCCEEDED &&
            db.detail(second).state() == TaskState.SUCCEEDED
        }
      }
    assertEquals(mapOf("to" to "ada@example.com"), db.detail(first).result())
    assertEquals(mapOf("to" to "grace@example.com"), db.detail(second).result())
  }

  @Test
  fun theExportIsCanceledAndAnotherExportRuns() {
    val queue = db.queue()
    val canceled = queue.enqueue("rows.export", listOf("row-1", "row-2")).taskId()
    runBlocking { LandingKotlin.CancellationExample.cancelExport(queue, canceled) }
    assertEquals(TaskState.CANCELED, db.detail(canceled).state())

    val exported = queue.enqueue("rows.export", listOf("row-3")).taskId()
    worker { with(LandingKotlin.CancellationExample) { registerExport() } }
      .use { db.runUntil(it, exported, TaskState.SUCCEEDED) }
    assertEquals(mapOf("stopped" to false), db.detail(exported).result())
  }

  @Test
  fun theDeclinedChargeIsRedriven() {
    val taskId =
      db
        .queue()
        .enqueue(
          "charge.capture",
          mapOf("chargeId" to "kotlin"),
          EnqueueOptions.builder().queue("billing").maxAttempts(1).build(),
        )
        .taskId()
    worker("billing") {
        handle<Map<String, Any?>>("charge.capture") { _, _ -> throw CardDeclined() }
      }
      .use { db.runUntil(it, taskId, TaskState.FAILED) }
    val admin = db.admin()
    runBlocking { LandingKotlin.DeadLettersExample.redriveBilling(admin) }
    val failure =
      admin.listDeadLetters(DeadLetterQuery.builder().queue("billing").build()).items().first {
        it.taskId() == taskId
      }
    assertEquals(1L, failure.redriveCount())
  }

  @Test
  fun theDashboardAnswersAnAdminSession() {
    ExampleServer { context ->
      // The test server sends the user as X-User. The snippet reads X-Admin.
      context
        .addFilter("admin-header") { request, response, chain ->
          chain.doFilter(
            object : HttpServletRequestWrapper(request as HttpServletRequest) {
              override fun getHeader(name: String): String? =
                if (name.equals("X-Admin", ignoreCase = true)) super.getHeader("X-User")
                else super.getHeader(name)
            },
            response,
          )
        }
        .addMappingForUrlPatterns(null, false, "/*")
      LandingKotlin.OperateDashboardExample.mount(db.dataSource(), context)
    }
      .use { server ->
        assertEquals(401, server.get("/workhorse", ""), "no session answers 401")
        assertEquals(
          302,
          server.get("/workhorse", "dana"),
          "an admin session reaches the dashboard",
        )
        assertEquals(200, server.get("/other", ""), "another path reaches the application")
      }
  }

  @Test
  fun theHealthCheckPrintsTheNumberOfLiveTasks() {
    db
      .queue()
      .enqueue(
        "report.build",
        mapOf("reportId" to "kotlin"),
        EnqueueOptions.builder().runAt(Instant.now().plus(1, ChronoUnit.DAYS)).build(),
      )
    val lines = LandingDatabase.standardOutput {
      runBlocking { LandingKotlin.OperateHealthExample.inspect(db.dataSource()) }
    }
    assertTrue(lines.last().toInt() >= 1, lines.joinToString("\n"))
  }

  @Test
  fun theBillingWorkerIsPaused() {
    val admin = db.admin()
    Worker.builder(db.dataSource()).queues("billing").workerId("billing-kotlin").build().use {
      worker ->
      worker.start()
      LandingDatabase.await { isPaused(admin, "billing-kotlin") != null }
      runBlocking { LandingKotlin.OperateFleetExample.pauseBilling(db.dataSource()) }
      LandingDatabase.await { isPaused(admin, "billing-kotlin") == true }
    }
  }

  /** Whether the registry shows [workerId] as paused, or null when it lists no such worker. */
  private fun isPaused(admin: Admin, workerId: String): Boolean? =
    admin.listWorkers().firstOrNull { it.workerId() == workerId }?.paused()
}
