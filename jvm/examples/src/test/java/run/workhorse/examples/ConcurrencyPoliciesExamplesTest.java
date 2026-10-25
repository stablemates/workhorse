package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.SQLException;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.Budget;
import run.workhorse.ConcurrencyPolicy;
import run.workhorse.ConnectionSource;
import run.workhorse.Queue;
import run.workhorse.TaskDetail;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippets of the site page about concurrency policies. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class ConcurrencyPoliciesExamplesTest {
  private final Queue queue = new Queue(ConnectionSource.of(ExampleDatabase.dataSource()));
  private final ConcurrencyPoliciesExamples examples = new ConcurrencyPoliciesExamples(queue);

  @Test
  void theSyncStoresThePolicyOfTheMailQueue() {
    List<ConcurrencyPolicy> policies = examples.syncPolicies();
    assertEquals(1, policies.size());
    ConcurrencyPolicy policy = policies.get(0);
    assertEquals("workers", policy.namespace());
    assertEquals("mail", policy.queue());
    assertEquals(20, policy.maxActive());
    assertEquals(3, policy.maxActivePerKey());
    assertTrue(queue.listConcurrencyPolicies(List.of("mail")).contains(policy));
  }

  @Test
  void theEnqueueStoresTheConcurrencyKey() throws SQLException {
    String messageId = "java-" + UUID.randomUUID();
    examples.enqueueWithKey(messageId, "acme");
    TaskDetail task = ExampleDatabase.task("mail.send", "messageId", messageId);
    assertEquals("mail", task.queue());
    assertEquals("acme", task.concurrencyKey());
  }

  @Test
  void theWarehouseLimitStoresThePolicyAndTheKey() throws SQLException {
    String orderId = "java-" + UUID.randomUUID();
    examples.limitEachWarehouse(orderId, "warehouse-berlin");
    ConcurrencyPolicy policy = queue.listConcurrencyPolicies(List.of("fulfillment")).get(0);
    assertEquals("shop", policy.namespace());
    assertEquals(20, policy.maxActive());
    assertEquals(2, policy.maxActivePerKey());
    TaskDetail task = ExampleDatabase.task("order.fulfill", "orderId", orderId);
    assertEquals("fulfillment", task.queue());
    assertEquals("warehouse-berlin", task.concurrencyKey());
  }

  @Test
  void theBudgetLimitsTwoQueues() throws SQLException {
    List<Budget> budgets = examples.budgets();
    assertEquals(1, budgets.size());
    assertEquals("vendor-api", budgets.get(0).name());
    assertEquals(4, budgets.get(0).maxActive());
    TaskDetail invoice =
        ExampleDatabase.detail(PolicyExampleRows.newestTask("invoice.sync", "id", "1"));
    TaskDetail contact =
        ExampleDatabase.detail(PolicyExampleRows.newestTask("contact.sync", "id", "2"));
    assertEquals("billing", invoice.queue());
    assertEquals("crm", contact.queue());
    assertEquals("vendor-api", PolicyExampleRows.budgetName(invoice.id()));
    assertEquals("vendor-api", PolicyExampleRows.budgetName(contact.id()));
  }
}
