package run.workhorse.examples;

import java.util.List;
import java.util.Optional;
import javax.sql.DataSource;
import run.workhorse.Admin;
import run.workhorse.AdminAudit;
import run.workhorse.ConnectionSource;
import run.workhorse.WorkerInfo;
import run.workhorse.WorkerPauseResult;

/** The Java tab of the site page about operations. */
public final class OperationsExamples {
  private final DataSource dataSource;

  /** The snippets read and change the worker registry of this database. */
  public OperationsExamples(DataSource dataSource) {
    this.dataSource = dataSource;
  }

  /** Lists the fleet and pauses {@code billing-worker-1}. Returns the fleet and the pause. */
  Pause pauseWorker(OperationsActor actor, String incidentId) {
    // docs:start java-operations-pause-worker
    Admin admin = new Admin(ConnectionSource.of(dataSource));
    List<WorkerInfo> workers = admin.listWorkers();
    Optional<WorkerPauseResult> result =
        admin.setWorkerPaused(
            "billing-worker-1",
            true,
            new AdminAudit(actor.email(), "investigating slow provider", incidentId));
    // docs:end
    return new Pause(workers, result);
  }

  /** The fleet before the pause, and the result of the pause. */
  record Pause(List<WorkerInfo> workers, Optional<WorkerPauseResult> result) {}
}
