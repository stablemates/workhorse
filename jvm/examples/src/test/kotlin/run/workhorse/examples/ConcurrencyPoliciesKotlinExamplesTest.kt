package run.workhorse.examples

import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.ConnectionSource
import run.workhorse.Queue
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippets of the site page about concurrency policies. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class ConcurrencyPoliciesKotlinExamplesTest {
  private val queue = Queue(ConnectionSource.of(ExampleDatabase.dataSource()))

  @Test
  fun theSyncStoresThePolicyOfTheMailQueue() = runBlocking {
    val policies = ConcurrencyPoliciesKotlinExamples.syncPolicies(queue)
    assertEquals(1, policies.size)
    val policy = policies[0]
    assertEquals("workers", policy.namespace)
    assertEquals("mail", policy.queue)
    assertEquals(20, policy.maxActive)
    assertEquals(3, policy.maxActivePerKey)
    assertTrue(queue.listConcurrencyPolicies(listOf("mail")).contains(policy))
  }

  @Test
  fun theEnqueueStoresTheConcurrencyKey() = runBlocking {
    val messageId = "kotlin-${UUID.randomUUID()}"
    ConcurrencyPoliciesKotlinExamples.enqueueWithKey(queue, messageId, "acme")
    val task = ExampleDatabase.task("mail.send", "messageId", messageId)
    assertEquals("mail", task.queue)
    assertEquals("acme", task.concurrencyKey)
  }

  @Test
  fun theBudgetLimitsTwoQueues() = runBlocking {
    val budgets = ConcurrencyPoliciesKotlinExamples.budgets(queue)
    assertEquals(1, budgets.size)
    assertEquals("vendor-api", budgets[0].name)
    assertEquals(4, budgets[0].maxActive)
    val invoice = ExampleDatabase.detail(PolicyExampleRows.newestTask("invoice.sync", "id", "1"))
    val contact = ExampleDatabase.detail(PolicyExampleRows.newestTask("contact.sync", "id", "2"))
    assertEquals("billing", invoice.queue)
    assertEquals("crm", contact.queue)
    assertEquals("vendor-api", PolicyExampleRows.budgetName(invoice.id))
    assertEquals("vendor-api", PolicyExampleRows.budgetName(contact.id))
  }
}
