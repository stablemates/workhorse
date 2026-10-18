package run.workhorse.internal;

/**
 * Unwinds a handler that a durable wait or a child join suspended (ADR 0103, "Suspension"). It
 * extends {@link Error}, so {@code catch (Exception e)} in a handler does not catch it, and {@code
 * finally} blocks still run. Handlers never construct it.
 */
public final class Suspension extends Error {
  private static final long serialVersionUID = 1L;

  /** A suspension. */
  public Suspension() {
    super("task handler suspended", null, false, false);
  }
}
