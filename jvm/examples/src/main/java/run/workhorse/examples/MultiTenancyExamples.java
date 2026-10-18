package run.workhorse.examples;

import java.util.List;
import java.util.Map;
import run.workhorse.BudgetDefinition;
import run.workhorse.ConcurrencyPolicyDefinition;
import run.workhorse.EnqueueOptions;
import run.workhorse.EnqueueResult;
import run.workhorse.Queue;

/** The Java tabs of the site page about multi-tenancy. */
public final class MultiTenancyExamples {
  private final Queue queue;

  /** The snippets run on this queue. */
  public MultiTenancyExamples(Queue queue) {
    this.queue = queue;
  }

  EnqueueResult tenantOptions() {
    // docs:start java-multi-tenancy-options
    String tenant = "acme";

    queue.syncConcurrencyPolicies(
        "workers", List.of(new ConcurrencyPolicyDefinition("reports", 40, 4)));
    queue.syncBudgets("workers", List.of(new BudgetDefinition(tenant, 8, null)));

    EnqueueResult result =
        queue.enqueue(
            "report.generate",
            Map.of("month", "2026-08"),
            EnqueueOptions.builder()
                .queue("reports")
                .concurrencyKey(tenant)
                .budget(tenant)
                .tags("tenant:" + tenant)
                .build());
    // docs:end
    return result;
  }
}
