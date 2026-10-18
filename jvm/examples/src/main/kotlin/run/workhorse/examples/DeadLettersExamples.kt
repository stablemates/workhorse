package run.workhorse.examples

import java.time.Instant
import java.util.UUID
import run.workhorse.Admin
import run.workhorse.AdminAudit
import run.workhorse.BulkRedrivePage
import run.workhorse.DeadLetterPage
import run.workhorse.DeadLetterQuery
import run.workhorse.RedriveFilter
import run.workhorse.RedriveResult
import run.workhorse.kotlin.listDeadLettersSuspend
import run.workhorse.kotlin.redriveManySuspend
import run.workhorse.kotlin.redriveSuspend

/** The Kotlin tabs of the site page about dead letters and redrive. */
class DeadLettersKotlinExamples(private val admin: Admin) {
  /** Lists the failed tasks of the outage. */
  suspend fun listFailures(): DeadLetterPage {
    // docs:start kotlin-dead-letters-list
    val page =
      admin.listDeadLettersSuspend(
        DeadLetterQuery.builder()
          .queue("payments")
          .errorName("ProviderTimeout")
          .finishedAfter(Instant.parse("2026-03-14T09:00:00Z"))
          .build(),
      )
    // docs:end
    return page
  }

  /** Redrives one failed task. */
  suspend fun redriveOne(sourceTaskId: UUID): RedriveResult {
    // docs:start kotlin-dead-letters-redrive
    val result =
      admin.redriveSuspend(
        sourceTaskId,
        AdminAudit("ops@example.com", "Provider outage ended", "r-77"),
      )
    // docs:end
    return result
  }

  /** Redrives the backlog in pages, and returns the dry run of the first page. */
  suspend fun redriveBacklog(): BulkRedrivePage {
    // docs:start kotlin-dead-letters-redrive-many
    val filter =
      RedriveFilter.builder().queue("payments").errorName("ProviderTimeout").limit(100).build()
    val audit = AdminAudit("ops@example.com", "Provider outage ended", "outage-0314")
    val preview = admin.redriveManySuspend(filter.toBuilder().dryRun(true).build(), audit)
    var page = admin.redriveManySuspend(filter, audit)
    while (page.nextCursor() != null) {
      page = admin.redriveManySuspend(filter.toBuilder().cursor(page.nextCursor()).build(), audit)
    }
    // docs:end
    return preview
  }
}
