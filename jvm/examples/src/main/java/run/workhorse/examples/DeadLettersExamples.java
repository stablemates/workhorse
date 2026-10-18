package run.workhorse.examples;

import java.time.Instant;
import java.util.UUID;
import run.workhorse.Admin;
import run.workhorse.AdminAudit;
import run.workhorse.BulkRedrivePage;
import run.workhorse.DeadLetterPage;
import run.workhorse.DeadLetterQuery;
import run.workhorse.RedriveFilter;
import run.workhorse.RedriveResult;

/** The Java tabs of the site page about dead letters and redrive. */
public final class DeadLettersExamples {
  private final Admin admin;

  /** The snippets run on this admin client. */
  public DeadLettersExamples(Admin admin) {
    this.admin = admin;
  }

  DeadLetterPage listFailures() {
    // docs:start java-dead-letters-list
    DeadLetterPage page =
        admin.listDeadLetters(
            DeadLetterQuery.builder()
                .queue("payments")
                .errorName("ProviderTimeout")
                .finishedAfter(Instant.parse("2026-03-14T09:00:00Z"))
                .build());
    // docs:end
    return page;
  }

  RedriveResult redriveOne(UUID sourceTaskId) {
    // docs:start java-dead-letters-redrive
    RedriveResult result =
        admin.redrive(
            sourceTaskId, new AdminAudit("ops@example.com", "Provider outage ended", "r-77"));
    // docs:end
    return result;
  }

  /** Redrives the backlog in pages, and returns the dry run of the first page. */
  BulkRedrivePage redriveBacklog() {
    // docs:start java-dead-letters-redrive-many
    RedriveFilter filter =
        RedriveFilter.builder().queue("payments").errorName("ProviderTimeout").limit(100).build();
    AdminAudit audit = new AdminAudit("ops@example.com", "Provider outage ended", "outage-0314");
    BulkRedrivePage preview = admin.redriveMany(filter.toBuilder().dryRun(true).build(), audit);
    BulkRedrivePage page = admin.redriveMany(filter, audit);
    while (page.nextCursor() != null) {
      page = admin.redriveMany(filter.toBuilder().cursor(page.nextCursor()).build(), audit);
    }
    // docs:end
    return preview;
  }
}
