// The Kotlin tabs of the site page about multi-tenancy.

package run.workhorse.examples

import run.workhorse.BudgetDefinition
import run.workhorse.ConcurrencyPolicyDefinition
import run.workhorse.EnqueueOptions
import run.workhorse.EnqueueResult
import run.workhorse.Queue
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.kotlin.syncBudgetsSuspend
import run.workhorse.kotlin.syncConcurrencyPoliciesSuspend

/** The Kotlin snippets of the site page about multi-tenancy. */
object MultiTenancyKotlinExamples {
  /** Writes one tenant into the three enqueue options. */
  suspend fun tenantOptions(queue: Queue): EnqueueResult {
    // docs:start kotlin-multi-tenancy-options
    val tenant = "acme"

    queue.syncConcurrencyPoliciesSuspend(
      "workers",
      listOf(ConcurrencyPolicyDefinition("reports", 40, 4)),
    )
    queue.syncBudgetsSuspend("workers", listOf(BudgetDefinition(tenant, 8, null)))

    val result =
      queue.enqueueSuspend(
        "report.generate",
        mapOf("month" to "2026-08"),
        EnqueueOptions.builder()
          .queue("reports")
          .concurrencyKey(tenant)
          .budget(tenant)
          .tags("tenant:$tenant")
          .build(),
      )
    // docs:end
    return result
  }
}
