package run.workhorse.examples;

import org.jspecify.annotations.Nullable;
import run.workhorse.CancellationToken;

/** The file store of the cancellation snippets. */
public interface CancellationPartUploader {
  /** Uploads one part of an order. A slow upload can stop when {@code cancellation} fires. */
  void upload(@Nullable Object part, CancellationToken cancellation) throws InterruptedException;
}
