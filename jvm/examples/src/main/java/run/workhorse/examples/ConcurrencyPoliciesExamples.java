package run.workhorse.examples;

import java.util.List;
import java.util.Map;
import run.workhorse.Budget;
import run.workhorse.BudgetDefinition;
import run.workhorse.ConcurrencyPolicy;
import run.workhorse.ConcurrencyPolicyDefinition;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;

/** The Java tabs of the site page about concurrency policies. */
public final class ConcurrencyPoliciesExamples {
  private final Queue queue;

  /** The snippets run on this queue. */
  public ConcurrencyPoliciesExamples(Queue queue) {
    this.queue = queue;
  }

  List<ConcurrencyPolicy> syncPolicies() {
    // docs:start java-concurrency-policies-sync
    List<ConcurrencyPolicy> policies =
        queue.syncConcurrencyPolicies(
            "workers", List.of(new ConcurrencyPolicyDefinition("mail", 20, 3)));
    // docs:end
    return policies;
  }

  void enqueueWithKey(String messageId, String tenantId) {
    // docs:start java-concurrency-policies-key
    queue.enqueue(
        "mail.send",
        Map.of("messageId", messageId),
        EnqueueOptions.builder().queue("mail").concurrencyKey(tenantId).build());
    // docs:end
  }

  List<Budget> budgets() {
    // docs:start java-concurrency-policies-budget
    List<Budget> budgets =
        queue.syncBudgets("workers", List.of(new BudgetDefinition("vendor-api", 4, null)));

    queue.enqueue(
        "invoice.sync",
        Map.of("id", 1),
        EnqueueOptions.builder().queue("billing").budget("vendor-api").build());
    queue.enqueue(
        "contact.sync",
        Map.of("id", 2),
        EnqueueOptions.builder().queue("crm").budget("vendor-api").build());
    // docs:end
    return budgets;
  }
}
