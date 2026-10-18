package run.workhorse.examples

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

/** Runs the Kotlin snippets of the site page about multi-tenancy. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class MultiTenancyKotlinExamplesTest {
  private val queue = Queue(ConnectionSource.of(ExampleDatabase.dataSource()))

  @Test
  fun oneTenantGoesIntoThreeEnqueueOptions() = runBlocking {
    val task = ExampleDatabase.detail(MultiTenancyKotlinExamples.tenantOptions(queue).taskId())
    assertEquals("reports", task.queue)
    assertEquals("acme", task.concurrencyKey)
    assertEquals(listOf("tenant:acme"), task.tags)
    assertEquals("acme", PolicyExampleRows.budgetName(task.id))
    assertTrue(
      queue.listConcurrencyPolicies(listOf("reports")).any {
        it.maxActive == 40 && it.maxActivePerKey == 4
      },
    )
    assertTrue(queue.listBudgets(listOf("acme")).any { it.maxActive == 8 })
  }
}
