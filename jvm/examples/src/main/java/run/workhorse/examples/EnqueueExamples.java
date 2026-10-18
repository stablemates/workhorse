package run.workhorse.examples;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import run.workhorse.Admin;
import run.workhorse.AdminAudit;
import run.workhorse.EnqueueOptions;
import run.workhorse.EnqueueRequest;
import run.workhorse.EnqueueResult;
import run.workhorse.Queue;

/** The Java tabs of the site page about enqueue. */
public final class EnqueueExamples {
  private final Queue queue;
  private final Admin admin;

  /** The snippets run on this queue and this admin client. */
  public EnqueueExamples(Queue queue, Admin admin) {
    this.queue = queue;
    this.admin = admin;
  }

  void enqueueNowOrLater(String invoiceId, Instant reminderDate) {
    // docs:start java-enqueue-now-or-later
    queue.enqueue("email.send", Map.of("to", "person@example.com"));
    queue.enqueue(
        "invoice.remind",
        Map.of("invoiceId", invoiceId),
        EnqueueOptions.builder().queue("billing").runAt(reminderDate).build());
    // docs:end
  }

  void enqueueWithOptions(Instant endOfMonth) {
    // docs:start java-enqueue-options
    queue.enqueue(
        "report.generate",
        Map.of("month", "2026-08"),
        EnqueueOptions.builder()
            .queue("reports")
            .tags("tenant:acme")
            .concurrencyKey("acme")
            .priority(10)
            .maxAttempts(5)
            .deadline(endOfMonth)
            .executionTimeout(Duration.ofMinutes(2))
            .build());
    // docs:end
  }

  List<EnqueueResult> enqueueMany(List<Recipient> recipients) {
    // docs:start java-enqueue-many
    List<EnqueueResult> results =
        queue.enqueueMany(
            recipients.stream()
                .map(
                    recipient ->
                        EnqueueRequest.of(
                            "email.digest",
                            Map.of("to", recipient.email()),
                            EnqueueOptions.builder().queue("mail").build()))
                .toList());
    // docs:end
    return results;
  }

  void pauseAndResume(String actor, String reason, String requestId, String resumeRequestId) {
    // docs:start java-pause-resume-queue
    admin.pauseQueue("billing", new AdminAudit(actor, reason, requestId));
    admin.resumeQueue("billing", new AdminAudit(actor, reason, resumeRequestId));
    // docs:end
  }
}
