package run.workhorse.examples

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.TaskState
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin handler of the site page about human waits. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class HumanWaitsKotlinExamplesTest {
  private val dataSource = ExampleDatabase.dataSource()
  private val driver = DurableFlowDriver(dataSource)

  @Test
  fun anApprovalActivatesTheAccountInTheSameAttempt() {
    val activated = CopyOnWriteArrayList<String>()
    durableFlowWorker(dataSource, driver) {
        HumanWaitsKotlinExamples(activated::add).register(this)
      }
      .use { worker ->
        val taskId = driver.enqueue("account.activate", mapOf("accountId" to "acct-19"))
        driver.completeHumanWait(worker, taskId, "account-review", mapOf("approved" to true))
        val task = driver.finish(worker, taskId)
        assertEquals(TaskState.SUCCEEDED, task.state())
        assertEquals(1, task.currentAttempt())
        assertEquals(listOf("acct-19"), activated)
      }
  }

  @Test
  fun aRejectionDoesNotActivateTheAccount() {
    val activated = CopyOnWriteArrayList<String>()
    durableFlowWorker(dataSource, driver) {
        HumanWaitsKotlinExamples(activated::add).register(this)
      }
      .use { worker ->
        val taskId = driver.enqueue("account.activate", mapOf("accountId" to "acct-19"))
        driver.completeHumanWait(worker, taskId, "account-review", mapOf("approved" to false))
        assertEquals(TaskState.SUCCEEDED, driver.finish(worker, taskId).state())
        assertEquals(emptyList<String>(), activated)
      }
  }
}
