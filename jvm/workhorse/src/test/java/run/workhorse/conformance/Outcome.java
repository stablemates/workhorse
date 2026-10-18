package run.workhorse.conformance;

import org.jspecify.annotations.Nullable;

/**
 * What one fixture did when the runner tried it. The counterpart of Ruby's {@code
 * Conformance::Outcome}.
 */
record Outcome(Status status, @Nullable String reason) {
  /**
   * {@code PASSED}; {@code FAILED}: the Java adapter ran and disagreed; {@code UNSUPPORTED}: no
   * Java adapter can express the fixture yet, because an open slice owns the surface; {@code
   * SKIPPED}: the runner could not reach the database the fixture needs.
   */
  enum Status {
    FAILED,
    PASSED,
    SKIPPED,
    UNSUPPORTED
  }

  static Outcome passed() {
    return new Outcome(Status.PASSED, null);
  }

  static Outcome failed(String reason) {
    return new Outcome(Status.FAILED, reason);
  }

  static Outcome unsupported(String reason) {
    return new Outcome(Status.UNSUPPORTED, reason);
  }

  static Outcome skipped(String reason) {
    return new Outcome(Status.SKIPPED, reason);
  }
}
