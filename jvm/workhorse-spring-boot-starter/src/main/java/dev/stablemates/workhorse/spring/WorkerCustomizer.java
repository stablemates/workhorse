package dev.stablemates.workhorse.spring;

import dev.stablemates.workhorse.Worker;

/**
 * Changes the {@link Worker.Builder} of the starter's worker after the {@code workhorse.worker.*}
 * properties and the {@code TaskHandler} beans apply. A bean of this type can set the options that
 * have no property, such as a retry delay, an executor, or an error listener.
 */
@FunctionalInterface
public interface WorkerCustomizer {
  /** Changes {@code builder}. */
  void customize(Worker.Builder builder);
}
