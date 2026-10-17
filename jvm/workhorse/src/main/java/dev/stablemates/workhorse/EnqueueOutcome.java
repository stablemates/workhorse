package dev.stablemates.workhorse;

/** What PostgreSQL did with one enqueue request. */
public enum EnqueueOutcome {
  /** PostgreSQL created a task. */
  ACCEPTED,
  /** An idempotency key returned its retained task. */
  REPLAYED,
  /** A debounce replaced the pending task. */
  REPLACED,
  /** A debounce could not replace the keyed task; the result names the reason. */
  NON_REPLACEABLE,
  /** A throttle or a debounce joined the request to an equivalent task. */
  COALESCED
}
