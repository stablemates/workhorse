package dev.stablemates.workhorse;

/**
 * The outcome of one batch member: {@link BatchSucceeded} or {@link BatchFailed}. A {@link
 * BatchHandler} returns one for each item.
 */
public sealed interface BatchHandlerOutcome permits BatchSucceeded, BatchFailed {}
