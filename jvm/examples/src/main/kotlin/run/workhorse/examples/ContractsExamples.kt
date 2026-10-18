// The Kotlin tabs of the site page about payload contracts.

package run.workhorse.examples

import run.workhorse.Queue
import run.workhorse.TaskContractVersion
import run.workhorse.TaskTypeContracts
import run.workhorse.kotlin.syncContractsSuspend

/** The Kotlin snippets of the site page about payload contracts. */
object ContractsKotlinExamples {
  /** Synchronizes the payload contract of `mail.send`. */
  suspend fun syncContracts(queue: Queue) {
    // docs:start kotlin-contracts-sync
    val contracts =
      mapOf(
        "mail.send" to
          TaskTypeContracts(
            "mail-current",
            mapOf(
              "mail-current" to
                TaskContractVersion(
                  mapOf("type" to "object", "required" to listOf("recipient")),
                  mapOf("type" to "object"),
                  null,
                  null,
                  listOf("accessToken"),
                  listOf(),
                ),
            ),
          ),
      )
    queue.syncContractsSuspend(contracts)
    // docs:end
  }
}
