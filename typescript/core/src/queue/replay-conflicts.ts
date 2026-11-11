import {
  CheckpointConflictError,
  CheckpointInputConflictError,
  WaitConflictError,
} from "./checkpoints-progress-waits.js";
import { ChildConflictError, isSecondChildSetLimit } from "./child-tasks.js";
import { HumanWaitConflictError } from "./human-waits.js";

/** The most errors of a cause chain that the conflict check reads. A cause chain can be a cycle. */
const MAX_CAUSE_DEPTH = 16;

/**
 * The durable replay conflict (ADR 0098), or the limit error of a second child set, in the cause
 * chain of `error`, or undefined. Each one ends the task with no retry. A second child set was a
 * replay conflict before `create_children_v2` named it a limit, so it stays terminal. Each other
 * child limit refusal follows the retry policy (the ADR 0098 amendment of SM-1956).
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
        isSecondChildSetLimit(current) ||
        current instanceof HumanWaitConflictError
      )
        return current;
      current = current.cause;
    }
  } catch {
    // A cause that is a revoked proxy throws on the instanceof check. Such a cause is no conflict.
  }
  return undefined;
}
