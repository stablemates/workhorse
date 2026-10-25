// The Kotlin tab of the site page "What is Workhorse?".

package run.workhorse.examples

import run.workhorse.ConcurrencyPolicyDefinition
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.kotlin.WorkerScope
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.kotlin.syncConcurrencyPoliciesSuspend

/** The onboarding of the page, with the services of the Java tab. */
class OverviewKotlinExamples(
  private val workspaces: OverviewExamples.Workspaces,
  private val mailer: OverviewExamples.Mailer,
) {
  /** Stores the tenant limit, enqueues one onboarding, and registers its handler. */
  suspend fun onboard(
    queue: Queue,
    scope: WorkerScope,
    accountId: String,
    email: String,
    tenantId: String,
  ) {
    // docs:start kotlin-overview-onboard
    // Step 1: allow three active onboardings per tenant, across all workers.
    // PostgreSQL applies this limit when a worker claims a task.
    queue.syncConcurrencyPoliciesSuspend(
      "accounts",
      listOf(ConcurrencyPolicyDefinition("onboarding", 20, 3)),
    )

    // Enqueue the task. The tenant is the concurrency key.
    queue.enqueueSuspend(
      "account.onboard",
      mapOf("accountId" to accountId, "email" to email),
      EnqueueOptions.builder().queue("onboarding").concurrencyKey(tenantId).build(),
    )

    scope.handle<Map<String, Any?>>("account.onboard") { ctx, account ->
      val id = account.getValue("accountId") as String

      // Step 2: create the workspace. The checkpoint stores it.
      // On a later run, it returns the stored workspace, and the handler
      // does not create a second one.
      val workspace =
        ctx.checkpoint<Map<String, Any?>>("workspace") { workspaces.create(id, "workspace:$id") }

      // Step 3: wait until the user verifies the email address. The task
      // releases its worker, and it does not count against the tenant limit.
      ctx.waitForSignal<Map<String, Any?>>("email-verified")

      // Step 4: the signal arrived. The handler ran again from its first line,
      // and the "workspace" checkpoint gave back the stored workspace.

      // Step 5: send the welcome email.
      val address = account.getValue("email") as String
      ctx.checkpoint<Map<String, Any?>>("welcome") { mailer.welcome(address, workspace) }
      workspace
    }
    // docs:end
  }
}
