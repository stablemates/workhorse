import {
  CheckpointConflictError,
  CheckpointInputConflictError,
  WaitConflictError,
} from "./checkpoints-progress-waits.js";
import { ChildConflictError } from "./child-tasks.js";
import { HumanWaitConflictError } from "./human-waits.js";

/** The most errors of a cause chain that the conflict check reads. A cause chain can be a cycle. */
const MAX_CAUSE_DEPTH = 16;

/**
 * The durable replay conflict (ADR 0098) in the cause chain of `error`, or undefined.
 *
 * A handler can wrap a conflict in its own error. The conflict is terminal also then, as in Go and
 * Rust, and the failure envelope records the name of the conflict.
 */
export function durableReplayConflict(error: unknown): Error | undefined {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (
      current instanceof CheckpointConflictError ||
      current instanceof CheckpointInputConflictError ||
      current instanceof WaitConflictError ||
      current instanceof ChildConflictError ||
      current instanceof HumanWaitConflictError
    )
      return current;
    current = current.cause;
  }
  return undefined;
}
