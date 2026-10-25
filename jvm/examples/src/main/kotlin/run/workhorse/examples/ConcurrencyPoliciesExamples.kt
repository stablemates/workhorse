// The Kotlin tabs of the site page about concurrency policies.

package run.workhorse.examples

import run.workhorse.Budget
import run.workhorse.BudgetDefinition
import run.workhorse.ConcurrencyPolicy
import run.workhorse.ConcurrencyPolicyDefinition
import run.workhorse.EnqueueOptions
import run.workhorse.Queue
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.kotlin.syncBudgetsSuspend
import run.workhorse.kotlin.syncConcurrencyPoliciesSuspend

/** The Kotlin snippets of the site page about concurrency policies. */
object ConcurrencyPoliciesKotlinExamples {
  /** Synchronizes the concurrency policy of the `mail` queue. */
  suspend fun syncPolicies(queue: Queue): List<ConcurrencyPolicy> {
    // docs:start kotlin-concurrency-policies-sync
    val policies =
      queue.syncConcurrencyPoliciesSuspend(
        "workers",
        listOf(ConcurrencyPolicyDefinition("mail", 20, 3)),
      )
    // docs:end
    return policies
  }

  /** Enqueues a task with a concurrency key. */
  suspend fun enqueueWithKey(queue: Queue, messageId: String, tenantId: String) {
    // docs:start kotlin-concurrency-policies-key
    queue.enqueueSuspend(
      "mail.send",
      mapOf("messageId" to messageId),
      EnqueueOptions.builder().queue("mail").concurrencyKey(tenantId).build(),
    )
    // docs:end
  }

  /** Synchronizes a budget and enqueues two tasks that name it. */
  suspend fun budgets(queue: Queue): List<Budget> {
    // docs:start kotlin-concurrency-policies-budget
    val budgets =
      queue.syncBudgetsSuspend("workers", listOf(BudgetDefinition("vendor-api", 4, null)))

    queue.enqueueSuspend(
      "invoice.sync",
      mapOf("id" to 1),
      EnqueueOptions.builder().queue("billing").budget("vendor-api").build(),
    )
    queue.enqueueSuspend(
      "contact.sync",
      mapOf("id" to 2),
      EnqueueOptions.builder().queue("crm").budget("vendor-api").build(),
    )
    // docs:end
    return budgets
  }
}
