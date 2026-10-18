package run.workhorse.examples;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import run.workhorse.HandlerContext;

/** The Java tab of the site page about progress. */
public final class ProgressExamples {
  private final ProgressImporter importer;

  /** The handler imports its rows with this importer. */
  public ProgressExamples(ProgressImporter importer) {
    this.importer = importer;
  }

  /** The handler of the import task. It returns the number of imported rows. */
  public Map<String, Object> importRows(HandlerContext context, Map<?, ?> payload)
      throws InterruptedException {
    int processed = 0;
    // docs:start java-progress-report
    context.setProgress(Map.of("phase", "reading", "processed", 0));
    for (List<String> batch : readBatches(payload.get("source"))) {
      importBatch(batch);
      processed += batch.size();
      context.setProgress(Map.of("phase", "importing", "processed", processed));
    }
    // docs:end
    return Map.of("processed", processed);
  }

  private List<List<String>> readBatches(@Nullable Object source) {
    return importer.readBatches(source);
  }

  private void importBatch(List<String> batch) throws InterruptedException {
    importer.importBatch(batch);
  }
}
