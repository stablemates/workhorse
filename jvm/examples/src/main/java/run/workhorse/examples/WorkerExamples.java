package run.workhorse.examples;

import java.time.Duration;
import java.util.Map;
import javax.sql.DataSource;
import run.workhorse.Worker;
import run.workhorse.WorkerProcess;

/** The Java tabs of the site page about workers. */
public final class WorkerExamples {
  private final DataSource dataSource;
  private final Mailer mailer;
  private final int workerConcurrency;
  private final Duration workerLease;

  /** The snippets build their workers from these values. */
  public WorkerExamples(
      DataSource dataSource, Mailer mailer, int workerConcurrency, Duration workerLease) {
    this.dataSource = dataSource;
    this.mailer = mailer;
    this.workerConcurrency = workerConcurrency;
    this.workerLease = workerLease;
  }

  /** Runs the worker until the process ends. */
  public void registerAndRun() {
    // docs:start java-register-handler
    Worker worker =
        Worker.builder(dataSource)
            .queues("email", "billing")
            .concurrency(workerConcurrency)
            .handle("email.send", Map.class, (context, payload) -> mailer.send(payload))
            .build();
    worker.run();
    // docs:end
  }

  /** Builds a worker with the options of the page, and does not run it. */
  public Worker withOptions() {
    // docs:start java-worker-options
    Worker worker =
        Worker.builder(dataSource)
            .queues("email", "billing")
            .concurrency(workerConcurrency)
            .lease(workerLease)
            .workerId("email-worker-1")
            .build();
    // docs:end
    return worker;
  }

  /** Runs the worker as the whole process. The process ends when the run ends. */
  public void runProcess() {
    // docs:start java-worker-process
    Worker worker =
        Worker.builder(dataSource)
            .queues("email", "billing")
            .concurrency(workerConcurrency)
            .handle("email.send", Map.class, (context, payload) -> mailer.send(payload))
            .build();
    WorkerProcess.runWorkerProcess(worker);
    // docs:end
  }
}
