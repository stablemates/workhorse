package run.workhorse;

/** What a schedule does with occurrences it missed. */
public enum CatchupPolicy {
  /** It skips them. */
  SKIP,
  /** It enqueues the latest one. */
  LATEST,
  /** It enqueues each of them. */
  ALL
}
