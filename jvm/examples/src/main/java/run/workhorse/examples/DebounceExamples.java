package run.workhorse.examples;

import java.time.Duration;
import java.util.Map;
import run.workhorse.Debounce;
import run.workhorse.DebounceSchedule;
import run.workhorse.EnqueueOptions;
import run.workhorse.EnqueueResult;
import run.workhorse.Queue;

/** The Java tabs of the site page about debounce. */
public final class DebounceExamples {
  private final Queue queue;

  /** The snippets run on this queue. */
  public DebounceExamples(Queue queue) {
    this.queue = queue;
  }

  EnqueueResult debounce(String documentId, int revision, Duration quietPeriod) {
    // docs:start java-debounce-enqueue
    EnqueueResult result =
        queue.enqueue(
            "search.reindex",
            Map.of("documentId", documentId, "revision", revision),
            EnqueueOptions.builder()
                .debounce(
                    new Debounce(documentId, quietPeriod, DebounceSchedule.RESET, "search-index"))
                .build());
    // docs:end
    return result;
  }
}
