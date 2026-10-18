// The Kotlin tabs of the site page of examples.

package run.workhorse.examples

import java.time.Duration
import java.time.Instant
import java.util.UUID
import javax.sql.DataSource
import run.workhorse.Admin
import run.workhorse.AdminAudit
import run.workhorse.ChildRequest
import run.workhorse.DeadLetterCursor
import run.workhorse.EnqueueOptions
import run.workhorse.Idempotency
import run.workhorse.Queue
import run.workhorse.RedriveFilter
import run.workhorse.ScheduleDefinition
import run.workhorse.ScheduledTask
import run.workhorse.Worker
import run.workhorse.WorkerProcess
import run.workhorse.kotlin.WorkerScope
import run.workhorse.kotlin.cancelSuspend
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.kotlin.redriveManySuspend
import run.workhorse.kotlin.syncSchedulesSuspend
import run.workhorse.kotlin.workhorseWorker

/** The snippets of the site page of examples. The object keeps their names apart. */
object ExamplesPageKotlin {
  // docs:start kotlin-examples-page-create-order
  suspend fun createOrder(
    dataSource: DataSource,
    queue: Queue,
    orderId: String,
    items: List<String>,
  ) {
    dataSource.connection.use { connection ->
      connection.autoCommit = false
      try {
        connection.prepareStatement("INSERT INTO orders (id, items) VALUES (?, ?)").use { insert ->
          insert.setString(1, orderId)
          insert.setArray(2, connection.createArrayOf("text", items.toTypedArray()))
          insert.executeUpdate()
        }
        queue.enqueueSuspend(
          "order.fulfill",
          mapOf("orderId" to orderId),
          EnqueueOptions.builder().queue("orders").build(),
          connection = connection,
        )
        connection.commit()
      } catch (error: Throwable) {
        connection.rollback()
        throw error
      }
    }
  }

  // docs:end

  // docs:start kotlin-examples-page-trial-lifecycle
  // Stand-ins for a mail provider. A real send passes the key to the provider's
  // idempotency option, and the provider drops a repeated send with the same key.
  fun sendWelcome(to: String, idempotencyKey: String): Map<String, Any?> =
    mapOf("deliveredTo" to to, "kind" to "welcome", "idempotencyKey" to idempotencyKey)

  fun sendFollowUp(to: String, idempotencyKey: String): Map<String, Any?> =
    mapOf("deliveredTo" to to, "kind" to "follow-up", "idempotencyKey" to idempotencyKey)

  fun registerTrialHandler(worker: WorkerScope) {
    worker.handle<Map<String, Any?>>("trial.lifecycle") { context, trial ->
      val to = trial["to"] as String
      context.checkpoint<Map<String, Any?>>("welcome") {
        sendWelcome(to, "welcome:${context.task.id()}")
      }
      context.sleepUntil("follow-up-window", Instant.parse(trial["followUpAt"] as String))
      context.checkpoint<Map<String, Any?>>("follow-up") {
        sendFollowUp(to, "follow-up:${context.task.id()}")
      }
      mapOf("deliveredTo" to to)
    }
  }

  // docs:end

  // docs:start kotlin-examples-page-billing-worker
  suspend fun runBillingWorker(dataSource: DataSource, queue: Queue) {
    // Deployment step: reconcile the namespace to exactly this set.
    val task =
      ScheduledTask("invoice.generate", mapOf("scope" to "due"), "billing", 0, null, null, null)
    queue.syncSchedulesSuspend(
      "billing-production",
      listOf(ScheduleDefinition("nightly-invoice-run", "0 3 * * *", task)),
    )

    // Worker process: evaluate and fire schedules for that namespace.
    val worker =
      workhorseWorker(dataSource) {
        queues = listOf("billing")
        scheduleNamespaces = listOf("billing-production")
        handle<Map<String, Any?>>("invoice.generate") { _, payload ->
          mapOf("generated" to true, "payload" to payload)
        }
      }
    WorkerProcess.runWorkerProcess(worker)
  }

  // docs:end

  // docs:start kotlin-examples-page-stripe-webhook
  data class StripeEvent(val id: String, val type: String, val data: Any?)

  suspend fun handleStripeWebhook(queue: Queue, event: StripeEvent): Map<String, UUID> {
    val result =
      queue.enqueueSuspend(
        "stripe.event",
        mapOf("eventId" to event.id, "eventType" to event.type),
        EnqueueOptions.builder()
          .queue("webhooks")
          .idempotency(Idempotency("stripe:${event.id}", "stripe-webhooks", Duration.ofDays(1)))
          .build(),
      )
    return mapOf("accepted" to result.taskId())
  }

  // docs:end

  // docs:start kotlin-examples-page-redrive-incident
  suspend fun redriveIncident(admin: Admin) {
    val filter =
      RedriveFilter.builder().queue("billing").errorName("ProviderTimeout").limit(100).build()
    val audit =
      AdminAudit("reviewer@example.com", "provider incident INC-2041 resolved", "INC-2041")

    val preview = admin.redriveManySuspend(filter.toBuilder().dryRun(true).build(), audit)
    println("${preview.results().size} tasks eligible")

    var cursor: DeadLetterCursor? = null
    do {
      val page = admin.redriveManySuspend(filter.toBuilder().cursor(cursor).build(), audit)
      for (result in page.results()) {
        println("${result.status()} ${result.sourceTaskId()} -> ${result.targetTaskId()}")
      }
      cursor = page.nextCursor()
    } while (cursor != null)
  }

  // docs:end

  // docs:start kotlin-examples-page-cancel-export
  fun uploadPart(part: String) = println("uploading $part")

  suspend fun configureExport(dataSource: DataSource, queue: Queue, taskId: UUID): Worker {
    queue.cancelSuspend(
      taskId,
      requestedBy = "support@example.com",
      reason = "customer withdrew the order",
    )

    return workhorseWorker(dataSource) {
      handle<Map<String, Any?>>("export.build") { context, export ->
        for (part in export["parts"] as List<*>) {
          context.cancellation.throwIfCancelled()
          uploadPart(part.toString())
        }
        mapOf("exported" to true)
      }
    }
  }

  // docs:end

  // docs:start kotlin-examples-page-agent-loop
  interface Model {
    suspend fun plan(prompt: String, idempotencyKey: String): Map<String, Any?>
  }

  fun registerAgent(worker: WorkerScope, model: Model, cooldown: Duration) {
    worker.handle<Map<String, Any?>>("agent.run") { context, run ->
      val prompt = run["prompt"] as String
      val conversationId = run["conversationId"] as String
      val plan =
        context.checkpoint<Map<String, Any?>>("plan") {
          model.plan(prompt, "plan:${context.task.id()}")
        }

      val children =
        (plan["tools"] as List<*>).map { value ->
          val tool = value as Map<*, *>
          ChildRequest.of(
            tool["id"] as String,
            "agent.tool",
            tool,
            EnqueueOptions.builder().queue("tools").concurrencyKey(conversationId).build(),
          )
        }

      val tools = context.runChildrenAll(children)
      context.sleep("model-cooldown", cooldown)
      val approval = context.waitForSignal<Map<String, Any?>>("approval")
      mapOf("plan" to plan, "tools" to tools, "approved" to (approval["approved"] == true))
    }
  }
  // docs:end
}
