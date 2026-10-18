package run.workhorse.examples;

import java.util.List;
import org.jspecify.annotations.Nullable;

/** The file import of the site page about progress. */
public interface ProgressImporter {
  /** Reads the rows of {@code source} in batches. */
  List<List<String>> readBatches(@Nullable Object source);

  /** Imports one batch of rows. */
  void importBatch(List<String> batch) throws InterruptedException;
}
