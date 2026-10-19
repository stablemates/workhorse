package run.workhorse.examples

import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.extension.ExtendWith
import run.workhorse.ConnectionSource
import run.workhorse.ContractValidationException
import run.workhorse.Queue
import run.workhorse.testing.ScratchDatabase

/** Runs the Kotlin snippets of the site page about payload contracts. */
@ExtendWith(ScratchDatabase::class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class ContractsKotlinExamplesTest {
  private val queue = Queue(ConnectionSource.of(ExampleDatabase.dataSource()))

  @AfterEach
  fun removeContract() {
    PolicyExampleRows.removeMailContract()
  }

  @Test
  fun theContractRejectsAPayloadWithoutARecipient() {
    runBlocking { ContractsKotlinExamples.syncContracts(queue) }
    val error =
      assertThrows(ContractValidationException::class.java) {
        queue.enqueue("mail.send", mapOf("to" to "ada@example.com"))
      }
    assertEquals("mail.send", error.taskType())
    assertEquals("mail-current", error.version())
    val recipient = "kotlin-${UUID.randomUUID()}@example.com"
    queue.enqueue("mail.send", mapOf("recipient" to recipient))
    assertEquals(
      "mail-current",
      ExampleDatabase.task("mail.send", "recipient", recipient).contractVersion,
    )
  }
}
