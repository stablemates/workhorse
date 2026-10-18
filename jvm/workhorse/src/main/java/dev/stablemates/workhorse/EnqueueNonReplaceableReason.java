package dev.stablemates.workhorse;

/** Why a debounced request was {@link EnqueueOutcome#NON_REPLACEABLE}. */
public enum EnqueueNonReplaceableReason {
  /** The key belongs to another coalescing mode. */
  INCOMPATIBLE_KEY_MODE,
  /** The keyed task is no longer pending. */
  NOT_PENDING,
  /** The window elapsed while the keyed task was still pending. */
  WINDOW_ELAPSED_PENDING
}
