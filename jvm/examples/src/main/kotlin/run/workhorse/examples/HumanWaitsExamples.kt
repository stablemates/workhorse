// The Kotlin tabs of the site page about human waits.

package run.workhorse.examples

import run.workhorse.kotlin.WorkerScope

/** The handler of the page. It gives each account that a person approves to [activations]. */
class HumanWaitsKotlinExamples(private val activations: (String) -> Unit) {
  /** Registers the `account.activate` handler, which waits for a human decision. */
  fun register(scope: WorkerScope) {
    scope.handle<Map<String, Any?>>("account.activate") { ctx, payload ->
      val accountId = payload.getValue("accountId") as String
      // docs:start kotlin-human-waits-wait
      val review =
        ctx.waitForHuman<Map<String, Any?>>(
          "account-review",
          mapOf("accountId" to accountId, "prompt" to "Approve this account?"),
        )

      if (review["approved"] == true) activateAccount(accountId)
      // docs:end
      review
    }
  }

  private fun activateAccount(accountId: String) = activations(accountId)
}
