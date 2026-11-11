import {
  CheckpointConflictError,
  CheckpointInputConflictError,
  CheckpointValueSizeLimitError,
  WaitConflictError,
} from "./checkpoints-progress-waits.js";
import {
  ChildConflictError,
  ChildLimitExceededError,
  ChildResultLimitExceededError,
} from "./child-tasks.js";
import { HumanWaitConflictError } from "./human-waits.js";

/** The most errors of a cause chain that the conflict check reads. A cause chain can be a cycle. */
const MAX_CAUSE_DEPTH = 16;

/**
 * The durable replay conflict (ADR 0098), or a child limit or child result limit error, in the
 * cause chain of `error`, or undefined. Each one ends the task with no retry. A handler replays the
 * same child calls on each attempt and gets the same refusal, so a retry cannot succeed (SM-2025).
 * An oversized checkpoint value is terminal too, because a retry runs its operation again
 * (SM-1982).
 *
 * A handler can wrap such an error in its own error. The error is terminal also then, as in Go and
 * Rust, and the failure envelope records its name.
 */
export function terminalReplayError(error: unknown): Error | undefined {
  let current = error;
  try {
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
      if (
        current instanceof CheckpointConflictError ||
        current instanceof CheckpointInputConflictError ||
        current instanceof WaitConflictError ||
        current instanceof ChildConflictError ||
        // Not replay conflicts, but terminal: a retry replays the same child calls and gets the
        // same refusal (SM-2025).
        current instanceof ChildLimitExceededError ||
        current instanceof ChildResultLimitExceededError ||
        current instanceof HumanWaitConflictError ||
        // Not a replay conflict, but terminal for the same reason: a retry runs the operation of
        // the checkpoint again and still cannot store its value (SM-1982).
        current instanceof CheckpointValueSizeLimitError
      )
        return current;
      current = current.cause;
    }
  } catch {
    // A cause that is a revoked proxy throws on the instanceof check. Such a cause is no conflict.
  }
  return undefined;
}
