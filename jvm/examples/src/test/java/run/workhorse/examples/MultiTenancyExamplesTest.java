package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.SQLException;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippets of the site page about multi-tenancy. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class MultiTenancyExamplesTest {
  private final Queue queue = new Queue(ConnectionSource.of(ExampleDatabase.dataSource()));

  @Test
  void oneTenantGoesIntoThreeEnqueueOptions() throws SQLException {
    TaskDetail task =
        ExampleDatabase.detail(new MultiTenancyExamples(queue).tenantOptions().taskId());
    assertEquals("reports", task.queue());
    assertEquals("acme", task.concurrencyKey());
    assertEquals(List.of("tenant:acme"), task.tags());
    assertEquals("acme", PolicyExampleRows.budgetName(task.id()));
    assertTrue(
        queue.listConcurrencyPolicies(List.of("reports")).stream()
            .anyMatch(policy -> policy.maxActive() == 40 && policy.maxActivePerKey() == 4));
    assertTrue(
        queue.listBudgets(List.of("acme")).stream()
            .anyMatch(budget -> budget.maxActive() != null && budget.maxActive() == 8));
  }
}
