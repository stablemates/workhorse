package run.workhorse.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import java.lang.reflect.Type;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.boot.health.contributor.Status;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.SmartLifecycle;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.support.GenericApplicationContext;
import run.workhorse.Admin;
import run.workhorse.ConnectionSource;
import run.workhorse.EnqueueOptions;
import run.workhorse.HandlerContext;
import run.workhorse.Queue;
import run.workhorse.ShutdownIncompleteException;
import run.workhorse.TaskHandler;
import run.workhorse.TaskState;
import run.workhorse.Worker;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/** The worker bean: its switch, its handlers, its drain, and its health. */
@ExtendWith({ScratchDatabase.class, OutputCaptureExtension.class})
class WorkerTest {
  /** The payload of the test task. The Jackson codec decodes it as this record. */
  record Shipment(String order) {}

  /** A handler bean that holds each attempt until the test releases it. */
  static final class ShipHandler implements TaskHandler<Shipment> {
    final CountDownLatch started = new CountDownLatch(1);
    final CountDownLatch release = new CountDownLatch(1);
    final AtomicReference<@Nullable Shipment> finished = new AtomicReference<>();
    volatile boolean ignoreInterrupts;

    @Override
    public String taskType() {
      return "order.ship";
    }

    @Override
    public Type payloadType() {
      return Shipment.class;
    }

    @Override
    public @Nullable Object handle(HandlerContext ctx, Shipment payload) throws Exception {
      started.countDown();
      if (ignoreInterrupts) {
        // A handler that ignores the shutdown: the worker abandons it after the unwind window.
        // It runs until the test releases it, whatever the timing of the drain.
        boolean released = false;
        while (!released) {
          try {
            released = release.await(10, TimeUnit.MILLISECONDS);
          } catch (InterruptedException ignored) {
            // The shutdown interrupts the handler. This handler does not stop for it.
          }
        }
      } else {
        release.await();
      }
      finished.set(payload);
      return null;
    }
  }

  /** A second handler bean for the task type of {@link ShipHandler}. */
  static final class OtherShipHandler implements TaskHandler<Shipment> {
    @Override
    public String taskType() {
      return "order.ship";
    }

    @Override
    public Type payloadType() {
      return Shipment.class;
    }

    @Override
    public @Nullable Object handle(HandlerContext ctx, Shipment payload) {
      return null;
    }
  }

  /**
   * A lifecycle bean one phase below the worker. It records whether the worker still ran when the
   * context stopped this bean.
   */
  static final class LowerPhase implements SmartLifecycle {
    final AtomicReference<WorkerLifecycle.@Nullable State> workerAtStop = new AtomicReference<>();
    private @Nullable WorkerLifecycle worker;
    private volatile boolean running;

    void watch(WorkerLifecycle worker) {
      this.worker = worker;
    }

    @Override
    public void start() {
      running = true;
    }

    @Override
    public void stop() {
      WorkerLifecycle current = worker;
      if (current != null) {
        workerAtStop.set(current.state());
      }
      running = false;
    }

    @Override
    public boolean isRunning() {
      return running;
    }

    @Override
    public int getPhase() {
      return SmartLifecycle.DEFAULT_PHASE - 1;
    }
  }

  /** The {@code Error} that {@link FatalHandler} throws. An {@code Error} ends the worker run. */
  static final class FatalError extends Error {
    private static final long serialVersionUID = 1L;

    FatalError() {
      super("fatal handler error");
    }
  }

  /** A handler bean whose {@code Error} ends the run without a stop. */
  static final class FatalHandler implements TaskHandler<Shipment> {
    @Override
    public String taskType() {
      return "order.fatal";
    }

    @Override
    public Type payloadType() {
      return Shipment.class;
    }

    @Override
    public @Nullable Object handle(HandlerContext ctx, Shipment payload) {
      throw new FatalError();
    }
  }

  /**
   * The lifecycle with the exit action of a process, which records the status instead of ending the
   * test JVM.
   */
  @Configuration(proxyBeanMethods = false)
  static class RecordedExit {
    static final AtomicReference<CompletableFuture<Integer>> STATUS =
        new AtomicReference<>(new CompletableFuture<>());

    @Bean
    WorkerLifecycle workhorseWorkerLifecycle(
        Worker worker, ConfigurableApplicationContext context) {
      CompletableFuture<Integer> status = STATUS.get();
      return new WorkerLifecycle(worker, failure -> ProcessExit.exit(context, status::complete));
    }
  }

  private static final String[] FATAL_PROPERTIES = {
    "workhorse.worker.enabled=true",
    "workhorse.worker.poll-interval=50ms",
    "workhorse.worker.disable-registry=true"
  };

  private static void enqueueFatal(ConfigurableApplicationContext context, String queueName) {
    context
        .getBean(Queue.class)
        .enqueue(
            "order.fatal", new Shipment("F-1"), EnqueueOptions.builder().queue(queueName).build());
  }

  private static void awaitEnd(Thread thread) throws InterruptedException {
    assertThat(thread.join(Duration.ofSeconds(10))).as("the watcher thread ends").isTrue();
  }

  private static ApplicationContextRunner enabled(String queueName, ShipHandler handler) {
    return Contexts.database()
        .withBean(ShipHandler.class, () -> handler)
        .withPropertyValues(
            "workhorse.worker.enabled=true",
            "workhorse.worker.queues=" + queueName,
            "workhorse.worker.poll-interval=50ms",
            "workhorse.worker.disable-registry=true");
  }

  private static UUID enqueue(ConfigurableApplicationContext context, String queueName) {
    return context
        .getBean(Queue.class)
        .enqueue(
            "order.ship", new Shipment("A-7"), EnqueueOptions.builder().queue(queueName).build())
        .taskId();
  }

  private static TaskState state(Admin admin, UUID taskId) {
    return admin.getTask(taskId).orElseThrow().state();
  }

  @Test
  void noWorkerStartsWithoutTheProperty() {
    ShipHandler handler = new ShipHandler();
    Contexts.runner()
        .withBean(DataSource.class, () -> mock(DataSource.class))
        .withBean(ShipHandler.class, () -> handler)
        .run(
            context -> {
              assertThat(context).hasSingleBean(Queue.class).hasSingleBean(Admin.class);
              assertThat(context).doesNotHaveBean(Worker.class);
              assertThat(context).doesNotHaveBean(WorkerLifecycle.class);
              assertThat(context).doesNotHaveBean(HealthIndicator.class);
              assertThat(Thread.getAllStackTraces().keySet())
                  .noneMatch(thread -> thread.getName().startsWith("workhorse-worker-"));
            });
  }

  @Test
  void theWorkerOffWarningNamesTheProperty(CapturedOutput output) {
    Contexts.runner()
        .withBean(DataSource.class, () -> mock(DataSource.class))
        .withBean(ShipHandler.class, ShipHandler::new)
        .withPropertyValues("workhorse.worker.enabled=false")
        .run(context -> assertThat(context).hasNotFailed());
    assertThat(output).contains("1 TaskHandler bean(s)").contains("workhorse.worker.enabled=true");
  }

  @Test
  void theWorkerRunsHandlerBeansWithTheJacksonCodec() throws Exception {
    String queueName = Contexts.unique("run");
    ShipHandler handler = new ShipHandler();
    enabled(queueName, handler)
        .run(
            context -> {
              UUID taskId = enqueue(context, queueName);
              assertThat(handler.started.await(10, TimeUnit.SECONDS)).isTrue();
              handler.release.countDown();
              long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
              Admin admin = context.getBean(Admin.class);
              while (state(admin, taskId) != TaskState.SUCCEEDED && System.nanoTime() < end) {
                Thread.sleep(20);
              }
              assertThat(state(admin, taskId)).isEqualTo(TaskState.SUCCEEDED);
              assertThat(handler.finished.get()).isEqualTo(new Shipment("A-7"));
            });
  }

  @Test
  void contextShutdownDrainsTheWorker() throws Exception {
    String queueName = Contexts.unique("drain");
    ShipHandler handler = new ShipHandler();
    AtomicReference<@Nullable WorkerLifecycle> lifecycle = new AtomicReference<>();
    AtomicReference<@Nullable UUID> task = new AtomicReference<>();
    Thread releaser =
        Thread.ofVirtual()
            .unstarted(
                () -> {
                  try {
                    // The context closes while the handler runs. The drain waits for it.
                    handler.started.await();
                    Thread.sleep(300);
                    handler.release.countDown();
                  } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                  }
                });
    enabled(queueName, handler)
        .withPropertyValues("workhorse.worker.shutdown-grace=10s")
        .run(
            context -> {
              lifecycle.set(context.getBean(WorkerLifecycle.class));
              task.set(enqueue(context, queueName));
              assertThat(handler.started.await(10, TimeUnit.SECONDS)).isTrue();
              releaser.start();
            });
    // The runner has closed the context.
    WorkerLifecycle stopped = lifecycle.get();
    assertThat(stopped).isNotNull();
    assertThat(handler.finished.get()).as("the handler finished during the drain").isNotNull();
    assertThat(stopped.state()).isEqualTo(WorkerLifecycle.State.STOPPED);
    assertThat(stopped.isRunning()).isFalse();
    UUID taskId = task.get();
    assertThat(taskId).isNotNull();
    Admin admin = new Admin(ConnectionSource.of(new ScratchDataSource(true)));
    assertThat(state(admin, taskId)).isEqualTo(TaskState.SUCCEEDED);
  }

  @Test
  void aStopRightAfterTheStartEndsTheRun() {
    String queueName = Contexts.unique("early");
    enabled(queueName, new ShipHandler())
        .run(
            context -> {
              WorkerLifecycle lifecycle = context.getBean(WorkerLifecycle.class);
              lifecycle.stop();
              lifecycle.start();
              // No pause between the start and the stop: the stop must reach the new run.
              lifecycle.stop();
              assertThat(lifecycle.state()).isEqualTo(WorkerLifecycle.State.STOPPED);
              assertThat(lifecycle.worker().isRunning()).isFalse();
              assertThat(lifecycle.isRunning()).isFalse();
            });
  }

  // SM-1517: an application that serves no web requests exits with a non-zero status.
  @Test
  @Timeout(value = 60, unit = TimeUnit.SECONDS)
  void aRunThatEndsWithoutAStopExitsANonWebProcessWithStatusOne() throws Exception {
    String queueName = Contexts.unique("exit");
    CompletableFuture<Integer> status = new CompletableFuture<>();
    RecordedExit.STATUS.set(status);
    Contexts.database()
        .withBean(FatalHandler.class, FatalHandler::new)
        .withUserConfiguration(RecordedExit.class)
        .withPropertyValues(FATAL_PROPERTIES)
        .withPropertyValues("workhorse.worker.queues=" + queueName)
        .run(
            context -> {
              WorkerLifecycle lifecycle = context.getBean(WorkerLifecycle.class);
              Thread watcher = lifecycle.watcher();
              assertThat(watcher).isNotNull();
              assertThat(watcher.isDaemon()).as("the watcher keeps the JVM alive").isFalse();
              enqueueFatal(context, queueName);

              // The exit closes the context from the watcher thread, and then exits. A wait on
              // the watcher from its own stop would never end.
              assertThat(status.get(30, TimeUnit.SECONDS)).isEqualTo(1);
              awaitEnd(watcher);
              assertThat(context.getSourceApplicationContext().isActive())
                  .as("the exit closed the context")
                  .isFalse();
              assertThat(lifecycle.state()).isEqualTo(WorkerLifecycle.State.FAILED);
              assertThat(lifecycle.failure()).isInstanceOf(FatalError.class);
            });
  }

  @Test
  void onlyANonWebApplicationExitsOnAFailedRun() {
    Contexts.database()
        .withPropertyValues(FATAL_PROPERTIES)
        .run(
            context ->
                assertThat(context.getBean(WorkerLifecycle.class).exitsOnFailure()).isTrue());
    Contexts.webDatabase()
        .withPropertyValues(FATAL_PROPERTIES)
        .run(
            context ->
                assertThat(context.getBean(WorkerLifecycle.class).exitsOnFailure()).isFalse());
  }

  @Test
  void aWebApplicationKeepsRunningAndReportsAFailedRunAsDown(CapturedOutput output)
      throws Exception {
    String queueName = Contexts.unique("web-failed");
    Contexts.webDatabase()
        .withBean(FatalHandler.class, FatalHandler::new)
        .withPropertyValues(FATAL_PROPERTIES)
        .withPropertyValues("workhorse.worker.queues=" + queueName)
        .run(
            context -> {
              WorkerLifecycle lifecycle = context.getBean(WorkerLifecycle.class);
              Thread watcher = lifecycle.watcher();
              assertThat(watcher).isNotNull();
              enqueueFatal(context, queueName);
              awaitEnd(watcher);

              assertThat(lifecycle.state()).isEqualTo(WorkerLifecycle.State.FAILED);
              assertThat(lifecycle.failure())
                  .as("known before any stop")
                  .isInstanceOf(FatalError.class);
              assertThat(lifecycle.isRunning()).isFalse();
              Health down =
                  context.getBean("workhorseHealthIndicator", HealthIndicator.class).health();
              assertThat(down.getStatus()).isEqualTo(Status.DOWN);
              assertThat(down.getDetails()).containsEntry("state", "failed");
              assertThat(context.getSourceApplicationContext().isActive()).isTrue();
            });
    assertThat(output).contains("stopped with an error").contains("fatal handler error");
  }

  @Test
  void aLifecycleStopEndsTheWatcherWithoutAnExit() throws Exception {
    String queueName = Contexts.unique("watch");
    AtomicReference<@Nullable WorkerLifecycle> lifecycle = new AtomicReference<>();
    enabled(queueName, new ShipHandler())
        .run(context -> lifecycle.set(context.getBean(WorkerLifecycle.class)));
    WorkerLifecycle stopped = lifecycle.get();
    assertThat(stopped).isNotNull();
    Thread watcher = stopped.watcher();
    assertThat(watcher).isNotNull();
    awaitEnd(watcher);
    assertThat(stopped.state()).isEqualTo(WorkerLifecycle.State.STOPPED);
    assertThat(stopped.failure()).isNull();
  }

  @Test
  void theHealthIndicatorReportsAStoppedWorker() throws Exception {
    String queueName = Contexts.unique("health");
    ShipHandler handler = new ShipHandler();
    enabled(queueName, handler)
        .run(
            context -> {
              HealthIndicator health =
                  context.getBean("workhorseHealthIndicator", HealthIndicator.class);
              assertThat(health.health().getStatus()).isEqualTo(Status.UP);

              context.getBean(WorkerLifecycle.class).stop();

              Health down = health.health();
              assertThat(down.getStatus()).isEqualTo(Status.DOWN);
              assertThat(down.getDetails()).containsEntry("state", "stopped");
            });
  }

  @Test
  void theHealthIndicatorReportsAnAbandonedHandler() throws Exception {
    String queueName = Contexts.unique("abandon");
    ShipHandler handler = new ShipHandler();
    handler.ignoreInterrupts = true;
    enabled(queueName, handler)
        .withPropertyValues("workhorse.worker.shutdown-grace=0s")
        .run(
            context -> {
              HealthIndicator health =
                  context.getBean("workhorseHealthIndicator", HealthIndicator.class);
              enqueue(context, queueName);
              assertThat(handler.started.await(10, TimeUnit.SECONDS)).isTrue();

              try {
                context.getBean(WorkerLifecycle.class).stop();

                Health down = health.health();
                assertThat(down.getStatus()).isEqualTo(Status.DOWN);
                assertThat(down.getDetails()).containsEntry("state", "failed");
                assertThat(context.getBean(WorkerLifecycle.class).failure())
                    .isInstanceOf(ShutdownIncompleteException.class);
              } finally {
                // Lets the abandoned handler end before the context closes.
                handler.release.countDown();
              }
              long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
              while (handler.finished.get() == null && System.nanoTime() < end) {
                Thread.sleep(10);
              }
              assertThat(handler.finished.get()).isNotNull();
            });
  }

  @ParameterizedTest
  @ValueSource(strings = {"on", "yes", "1", "no"})
  void theWorkerOffWarningAppearsWheneverNoWorkerBeanExists(String value, CapturedOutput output) {
    Contexts.runner()
        .withBean(DataSource.class, () -> mock(DataSource.class))
        .withBean(ShipHandler.class, ShipHandler::new)
        .withPropertyValues("workhorse.worker.enabled=" + value)
        .run(context -> assertThat(context).hasNotFailed().doesNotHaveBean(Worker.class));
    assertThat(output).contains("1 TaskHandler bean(s)").contains("workhorse.worker.enabled=true");
  }

  @Test
  void aRunningWorkerLogsNoWorkerOffWarning(CapturedOutput output) {
    enabled(Contexts.unique("no-warning"), new ShipHandler())
        .run(context -> assertThat(context).hasSingleBean(Worker.class));
    assertThat(output).doesNotContain("no Workhorse worker runs");
  }

  @Test
  void twoHandlerBeansForOneTaskTypeFailTheStartup() {
    enabled(Contexts.unique("duplicate"), new ShipHandler())
        .withBean("otherShipHandler", OtherShipHandler.class, OtherShipHandler::new)
        .run(
            context ->
                assertThat(context)
                    .getFailure()
                    .rootCause()
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("order.ship")
                    .hasMessageContaining("otherShipHandler"));
  }

  @Test
  void theWorkerUsesTheDataSourceThatThePropertyNames() throws Exception {
    String queueName = Contexts.unique("named");
    ShipHandler handler = new ShipHandler();
    handler.release.countDown();
    Contexts.runner()
        .withBean("jobsDataSource", DataSource.class, () -> new ScratchDataSource(true))
        .withBean("ordersDataSource", DataSource.class, () -> mock(DataSource.class))
        .withBean(ShipHandler.class, () -> handler)
        .withPropertyValues(
            "workhorse.data-source=jobsDataSource",
            "workhorse.worker.enabled=true",
            "workhorse.worker.queues=" + queueName,
            "workhorse.worker.poll-interval=50ms",
            "workhorse.worker.disable-registry=true")
        .run(
            context -> {
              UUID taskId = enqueue(context, queueName);
              Admin admin = context.getBean(Admin.class);
              long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
              while (state(admin, taskId) != TaskState.SUCCEEDED && System.nanoTime() < end) {
                Thread.sleep(20);
              }
              assertThat(state(admin, taskId)).isEqualTo(TaskState.SUCCEEDED);
            });
  }

  @Test
  void theWorkerStopsBeforeALifecycleBeanOfALowerPhase() {
    LowerPhase lower = new LowerPhase();
    enabled(Contexts.unique("phase"), new ShipHandler())
        .withBean(LowerPhase.class, () -> lower)
        .run(
            context -> {
              WorkerLifecycle lifecycle = context.getBean(WorkerLifecycle.class);
              assertThat(lifecycle.getPhase()).isEqualTo(SmartLifecycle.DEFAULT_PHASE);
              lower.watch(lifecycle);
            });
    assertThat(lower.workerAtStop.get()).isEqualTo(WorkerLifecycle.State.STOPPED);
  }

  @Test
  void theWorkerOffWarningCountsHandlerBeansOfAParentContext(CapturedOutput output) {
    try (GenericApplicationContext parent = new GenericApplicationContext()) {
      parent.registerBean(ShipHandler.class, ShipHandler::new);
      parent.refresh();
      Contexts.runner()
          .withParent(parent)
          .withBean(DataSource.class, () -> mock(DataSource.class))
          .run(context -> assertThat(context).hasNotFailed().doesNotHaveBean(Worker.class));
    }
    assertThat(output).contains("1 TaskHandler bean(s)");
  }
}
