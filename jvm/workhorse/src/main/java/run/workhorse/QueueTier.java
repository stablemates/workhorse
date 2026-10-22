package run.workhorse;

/**
 * The per-queue setting that decides how much Workhorse records for each task of the queue (ADR
 * 0077). The tier changes only while the queue holds no live task.
 */
public enum QueueTier {
  /** The opt-in tier for queues whose handlers never suspend. It writes history only on opt-in. */
  FAST,
  /** The default tier. It writes events and attempt history and supports every feature. */
  FULL
}
