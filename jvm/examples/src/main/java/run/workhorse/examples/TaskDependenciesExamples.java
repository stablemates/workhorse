package run.workhorse.examples;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import run.workhorse.Dependencies;
import run.workhorse.DependencyPolicy;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;

/** The Java tabs of the site page about task dependencies. */
public final class TaskDependenciesExamples {
  private final Queue queue;

  /** The snippets enqueue on this queue. */
  public TaskDependenciesExamples(Queue queue) {
    this.queue = queue;
  }

  /** Enqueues an import and a notification that waits for it, and returns the id of the import. */
  public UUID enqueueImportAndNotify() {
    // docs:start java-task-dependencies-enqueue
    UUID importId = queue.enqueue("contacts.import", Map.of("source", "upload")).taskId();
    queue.enqueue(
        "contacts.notify",
        Map.of("importId", importId.toString()),
        EnqueueOptions.builder()
            .dependencies(
                new Dependencies(
                    List.of(importId),
                    DependencyPolicy.RELEASE,
                    DependencyPolicy.FAIL,
                    DependencyPolicy.CANCEL))
            .build());
    // docs:end
    return importId;
  }
}
