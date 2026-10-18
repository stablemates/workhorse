// The Kotlin tabs of the site page about enqueue.

package run.workhorse.examples

import java.time.Duration
import java.time.Instant
import run.workhorse.Admin
import run.workhorse.AdminAudit
import run.workhorse.EnqueueOptions
import run.workhorse.EnqueueRequest
import run.workhorse.EnqueueResult
import run.workhorse.Queue
import run.workhorse.kotlin.enqueueManySuspend
import run.workhorse.kotlin.enqueueSuspend
import run.workhorse.kotlin.pauseQueueSuspend
import run.workhorse.kotlin.resumeQueueSuspend

suspend fun enqueueNowOrLater(queue: Queue, invoiceId: String, reminderDate: Instant) {
  // docs:start kotlin-enqueue-now-or-later
  queue.enqueueSuspend("email.send", mapOf("to" to "person@example.com"))
  queue.enqueueSuspend(
    "invoice.remind",
    mapOf("invoiceId" to invoiceId),
    EnqueueOptions.builder().queue("billing").runAt(reminderDate).build(),
  )
  // docs:end
}

suspend fun enqueueWithOptions(queue: Queue, endOfMonth: Instant) {
  // docs:start kotlin-enqueue-options
  queue.enqueueSuspend(
    "report.generate",
    mapOf("month" to "2026-08"),
    EnqueueOptions.builder()
      .queue("reports")
      .tags("tenant:acme")
      .concurrencyKey("acme")
      .priority(10)
      .maxAttempts(5)
      .deadline(endOfMonth)
      .executionTimeout(Duration.ofMinutes(2))
      .build(),
  )
  // docs:end
}

suspend fun enqueueMany(queue: Queue, recipients: List<Recipient>): List<EnqueueResult> {
  // docs:start kotlin-enqueue-many
  val results =
    queue.enqueueManySuspend(
      recipients.map { recipient ->
        EnqueueRequest.of(
          "email.digest",
          mapOf("to" to recipient.email),
          EnqueueOptions.builder().queue("mail").build(),
        )
      },
    )
  // docs:end
  return results
}

suspend fun pauseAndResume(
  admin: Admin,
  actor: String,
  reason: String,
  requestId: String,
  resumeRequestId: String,
) {
  // docs:start kotlin-pause-resume-queue
  admin.pauseQueueSuspend("billing", AdminAudit(actor, reason, requestId))
  admin.resumeQueueSuspend("billing", AdminAudit(actor, reason, resumeRequestId))
  // docs:end
}
