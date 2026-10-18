package run.workhorse.spring;

import org.jspecify.annotations.Nullable;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthIndicator;
import run.workhorse.Worker;

/**
 * Reports the state of the starter's worker (ADR 0103, "Spring Boot starter").
 *
 * <p>A running worker reports {@code UP}. A started worker that stops or stopped, or whose run
 * ended without a stop or abandoned a handler, reports {@code DOWN}. A worker that the context has
 * not started yet reports {@code UNKNOWN}.
 */
final class WorkerHealthIndicator implements HealthIndicator {
  private final WorkerLifecycle lifecycle;

  WorkerHealthIndicator(WorkerLifecycle lifecycle) {
    this.lifecycle = lifecycle;
  }

  @Override
  public Health health() {
    Worker worker = lifecycle.worker();
    WorkerLifecycle.State state = lifecycle.state();
    Health.Builder builder =
        switch (state) {
          case NEW -> Health.unknown();
          case RUNNING -> Health.up().withDetail("paused", worker.isPaused());
          case STOPPING, STOPPED -> Health.down();
          case FAILED -> {
            @Nullable Throwable failure = lifecycle.failure();
            yield failure == null ? Health.down() : Health.down(failure);
          }
        };
    return builder
        .withDetail("state", state.name().toLowerCase(java.util.Locale.ROOT))
        .withDetail("workerId", worker.workerId())
        .withDetail("queues", worker.queues())
        .withDetail("concurrency", worker.concurrency())
        .build();
  }
}
