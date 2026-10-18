package dev.stablemates.workhorse.conformance;

/** A fixture that disagrees with the Java SDK. The message names the first mismatch. */
final class Failure extends RuntimeException {
  private static final long serialVersionUID = 1L;

  Failure(String message) {
    super(message);
  }

  /** Fails with {@code message} unless {@code condition} holds. */
  static void check(boolean condition, String message) {
    if (!condition) {
      throw new Failure(message);
    }
  }
}
