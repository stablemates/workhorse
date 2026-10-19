// A durable agentic flow in an ordinary handler: a checkpointed plan, child tool tasks, a durable
// cooldown timer, and an approval signal. Each durable call of the handler suspends. The
// model and the tools are the deterministic stubs of `AgenticFlowProgram.defaultEffects()`, so the
// program calls no model API.
//
// Documentation: https://workhorse.run/docs/agentic-flow

package run.workhorse.examples.programs

import java.time.Duration
import java.util.UUID
import javax.sql.DataSource
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import run.workhorse.Admin
import run.workhorse.ChildRequest
import run.workhorse.ConnectionSource
import run.workhorse.EnqueueOptions
import run.workhorse.Idempotency
import run.workhorse.JsonCodec
import run.workhorse.Queue
import run.workhorse.RateLimit
import run.workhorse.RateLimitPolicyDefinition
import run.workhorse.SignalStatus
import run.workhorse.TaskState
import run.workhorse.Worker
import run.workhorse.kotlin.SuspendHandlerContext
import run.workhorse.kotlin.assertCompatibleSuspend
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.kotlin.getTaskSuspend
import run.workhorse.kotlin.sendSignalSuspend
import run.workhorse.kotlin.syncRateLimitPoliciesSuspend
import run.workhorse.kotlin.workhorseWorker

private val progressOrder = listOf("planned", "tools-complete", "awaiting-approval", "finalizing")

/** Sets the progress stage, unless the task already reached it or a later one. */
private suspend fun reportProgress(context: SuspendHandlerContext, stage: String) {
  val next = progressOrder.indexOf(stage)
  require(next >= 0) { "Unknown progress stage $stage" }
  val current = (context.getProgress()?.value as? Map<*, *>)?.get("stage")
  if (progressOrder.indexOf(current) >= next) return
  context.setProgress(mapOf("stage" to stage))
}

/** The parent worker that runs `agent.loop`. */
internal fun kotlinParentWorker(
  dataSource: DataSource,
  effects: AgenticFlowProgram.Effects,
  cooldown: Duration,
): Worker =
  workhorseWorker(dataSource) {
    queues = listOf(AgenticFlowProgram.PARENT_QUEUE)
    workerId = "agentic-flow-parent"
    pollInterval = Duration.ofMillis(1)
    handle<Map<String, Any?>>("agent.loop") { context, payload ->
      val prompt = payload["prompt"].toString()
      val conversationId = payload["conversationId"].toString()
      val taskId = context.task.id().toString()
      val plan =
        context.checkpoint<Map<String, Any?>>("plan") {
          effects.callModel("plan", prompt, null, "$taskId:plan")
        }
      reportProgress(context, "planned")

      val toolOptions =
        EnqueueOptions.builder()
          .queue(AgenticFlowProgram.TOOL_QUEUE)
          .concurrencyKey(conversationId)
          .build()
      val tools =
        context.runChildrenAll(
          listOf(
            ChildRequest.of(
              "research",
              "agent.tool",
              mapOf("tool" to "research", "input" to prompt),
              toolOptions,
            ),
            ChildRequest.of(
              "calculate",
              "agent.tool",
              mapOf("tool" to "calculate", "input" to prompt),
              toolOptions,
            ),
          ),
        )
      reportProgress(context, "tools-complete")

      context.sleep("model-cooldown", cooldown)
      reportProgress(context, "awaiting-approval")
      val approval = context.waitForSignal<Map<String, Any?>>("approval")
      if (approval["approved"] != true) {
        return@handle mapOf("status" to "rejected", "plan" to plan, "tools" to tools)
      }

      reportProgress(context, "finalizing")
      val response =
        context.checkpoint<Map<String, Any?>>("final-response") {
          effects.callModel("answer", prompt, tools, "$taskId:final-response")
        }
      mapOf("status" to "completed", "plan" to plan, "tools" to tools, "response" to response)
    }
  }

/** The tool worker that runs `agent.tool`. */
internal fun kotlinToolWorker(dataSource: DataSource, effects: AgenticFlowProgram.Effects): Worker =
  workhorseWorker(dataSource) {
    queues = listOf(AgenticFlowProgram.TOOL_QUEUE)
    workerId = "agentic-flow-tools"
    concurrency = 2
    pollInterval = Duration.ofMillis(1)
    handle<Map<String, Any?>>("agent.tool") { context, payload ->
      val key = "${context.task.id()}:tool-call"
      val result =
        context.checkpoint<Map<String, Any?>>("tool-call") {
          effects.callTool(payload["tool"].toString(), payload["input"].toString(), key)
        }
      reportProgress(context, "planned")
      result
    }
  }

/**
 * Runs one flow to its end, and returns the task id, its result, and its last progress value. The
 * loop runs a bounded number of passes.
 */
internal suspend fun runAgenticFlow(
  dataSource: DataSource,
  conversationId: String,
  prompt: String,
  cooldown: Duration,
  effects: AgenticFlowProgram.Effects,
): Map<String, Any?> {
  val queue = Queue(ConnectionSource.of(dataSource))
  queue.assertCompatibleSuspend()
  val admin = Admin(ConnectionSource.of(dataSource))
  queue.syncRateLimitPoliciesSuspend(
    AgenticFlowProgram.POLICY_NAMESPACE,
    listOf(
      RateLimitPolicyDefinition(
        AgenticFlowProgram.TOOL_QUEUE,
        RateLimit(100, Duration.ofSeconds(1), 100),
        RateLimit(10, Duration.ofSeconds(1), 10),
      ),
    ),
    prune = false,
  )

  kotlinParentWorker(dataSource, effects, cooldown).use { parent ->
    kotlinToolWorker(dataSource, effects).use { tools ->
      val taskId: UUID =
        queue
          .enqueueSuspend(
            "agent.loop",
            mapOf("conversationId" to conversationId, "prompt" to prompt),
            EnqueueOptions.builder()
              .queue(AgenticFlowProgram.PARENT_QUEUE)
              .idempotency(Idempotency("agentic-flow:$conversationId"))
              .build(),
          )
          .taskId()

      var approvalDelivered = false
      repeat(100) {
        parent.runOnce()
        tools.runOnce()

        if (!approvalDelivered) {
          val status =
            queue
              .sendSignalSuspend(
                taskId,
                "approval",
                mapOf("approved" to true),
                "agentic-flow:$conversationId:approval",
                "agentic-flow-example",
              )
              .status()
          approvalDelivered = status == SignalStatus.DELIVERED || status == SignalStatus.DUPLICATE
        }

        val snapshot = checkNotNull(admin.getTaskSuspend(taskId)) { "task $taskId is missing" }
        when (snapshot.state()) {
          TaskState.SUCCEEDED ->
            return mapOf(
              "taskId" to taskId.toString(),
              "result" to snapshot.result(),
              "progress" to snapshot.progress()?.value(),
            )
          TaskState.FAILED,
          TaskState.CANCELED ->
            throw IllegalStateException("Agentic flow finished in ${snapshot.state()} state")
          else -> delay(20)
        }
      }
      throw IllegalStateException(
        "Agentic flow $taskId did not finish within the bounded example loop",
      )
    }
  }
}

fun main() {
  val outcome = runBlocking {
    runAgenticFlow(
      Programs.dataSource("WORKHORSE_DATABASE_URL"),
      "conversation-example",
      "Explain durable agent execution",
      Duration.ofMillis(10),
      AgenticFlowProgram.defaultEffects(),
    )
  }
  println(JsonCodec.standard().encode(outcome))
}
