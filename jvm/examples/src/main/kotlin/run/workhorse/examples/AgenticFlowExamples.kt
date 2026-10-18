// The Kotlin tabs of the site page about the durable agentic flow.

package run.workhorse.examples

import java.time.Duration
import run.workhorse.ChildRequest
import run.workhorse.EnqueueOptions
import run.workhorse.kotlin.WorkerScope

/**
 * The handlers of the page. The loop plans with [model], runs its tools on [toolQueue], and waits
 * for [cooldown] before it asks for approval.
 */
class AgenticFlowKotlinExamples(
  private val model: (String) -> String,
  private val toolQueue: String,
  private val cooldown: Duration,
) {
  /** Registers the `agent.loop` handler and the two tool handlers. */
  fun register(scope: WorkerScope) {
    val toolOptions = EnqueueOptions.builder().queue(toolQueue).build()
    scope.handle<Map<String, Any?>>("agent.loop") { context, payload ->
      val prompt = payload.getValue("prompt") as String
      val toolRequests =
        listOf(
          ChildRequest.of("research", "agent.research", payload, toolOptions),
          ChildRequest.of("calculate", "agent.calculate", payload, toolOptions),
        )
      // docs:start kotlin-agentic-flow-loop
      val plan = context.checkpoint<String>("plan") { callModel(prompt) }
      context.setProgress(mapOf("stage" to "planned"))
      val tools = context.runChildrenAll(toolRequests)
      context.sleep("model-cooldown", cooldown)
      val approval = context.waitForSignal<Map<String, Any?>>("approval")
      // docs:end
      mapOf("plan" to plan, "tools" to tools, "approval" to approval)
    }
    scope.handle<Map<String, Any?>>("agent.research") { _, _ -> mapOf("sources" to 3L) }
    scope.handle<Map<String, Any?>>("agent.calculate") { _, _ -> mapOf("total" to 42L) }
  }

  private fun callModel(prompt: String): String = model(prompt)
}
