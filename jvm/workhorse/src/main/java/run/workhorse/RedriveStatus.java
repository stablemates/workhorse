package run.workhorse;

/** What a redrive did with one source task. */
public enum RedriveStatus {
  /** The redrive enqueued a fresh copy of the failed task. */
  REDRIVEN,
  /** An earlier redrive with the same request ID enqueued the copy, and this call replays it. */
  REPLAYED,
  /** A dry run found that the task can be redriven. */
  ELIGIBLE,
  /** No such task exists. */
  NOT_FOUND,
  /** The task is not failed. */
  NOT_FAILED
}
