# ADR 0098: Check the input of a checkpoint on replay

- **Status:** Accepted
- **Date:** 2026-10-12
- **Amends:** [ADR 0005](0005-explicit-durable-checkpoints.md). ADR 0005 compares a repeated
  checkpoint name only by its value. This ADR adds an optional input fingerprint.
- **Related:** [ADR 0030](0030-distinguish-suspensions-gates-and-child-joins.md)
- **Issue:** SM-1211

## Context

A checkpoint stores the result of an operation under a name. A replay finds the result by the name
only. It does not run the operation, so it cannot see the input of the operation.

Thus a deploy that changes the input gives a wrong result and no error. For example, a deploy adds a
discount before the `charge-card` checkpoint. A task that stored `charge-card` before the deploy
replays it, and the handler gets the amount without the discount. A child request does not have
this problem, because Workhorse stores its request fingerprint and compares it on replay.

## Decision

A handler can give the input of a checkpoint. Workhorse then stores a fingerprint of the input with
the result, and compares it on replay.

1. The fingerprint is the SHA-256 digest of the RFC 8785 canonical JSON of the input, as 64
   lowercase hexadecimal characters. The SDK computes it. Each SDK must give the same digest for
   the same input, so the canonical form is a published standard.
2. `task_checkpoint.input_fingerprint` stores the fingerprint. It is NULL for a checkpoint saved
   without an input. The column has no `CHECK`, because a `CHECK` on a new column scans the table
   under `ACCESS EXCLUSIVE`. `save_checkpoint_v2`, the only writer, refuses another format.
3. `save_checkpoint_v2` takes the fingerprint. If the name exists and both fingerprints are
   present and differ, it returns `input_conflict`. Otherwise it compares the value as
   `save_checkpoint_v1` does. `save_checkpoint_v1` calls `save_checkpoint_v2` with a NULL
   fingerprint, so its results do not change.
4. Before it returns a stored value, the SDK compares the fingerprint of the call with the stored
   fingerprint. A difference raises `CheckpointInputConflictError`, and the operation does not
   run.
5. A NULL fingerprint on either side never conflicts. The check is optional, and code can add an
   input while tasks wait on the old code.
6. `CheckpointInputConflictError` is a terminal replay conflict, as the other classes are since
   SM-1107. The worker fails the task at once and keeps the current attempt.
7. Each SDK refuses the same inputs, with its error for an invalid argument, and the operation does
   not run. SM-1274 adds this rule. An input has no fingerprint if it holds one of these:
   - a value that is not JSON, or a non-finite number;
   - a string or a key that is not valid Unicode text: invalid UTF-8, or a lone surrogate;
   - a number larger than 2^53 - 1 in magnitude, of any numeric type.

The TypeScript SDK gives the input as `ctx.checkpoint(name, operation, { input })`. The other SDKs
follow in parity issues.

The number limit applies to the value, not to the type. A TypeScript `Number`, a Go value after
`encoding/json`, and JSON text cannot show if a number was an integer or a float. They also cannot
show if a source integer was rounded before the SDK saw it. Every IEEE 754 double of 2^53 or more
in magnitude is an integer, so the limit refuses no fraction. Thus TypeScript refuses a `Number`
such as `2 ** 53` or `1e21`, and Python refuses the `float` `1e21` as it refuses the `int` `2**53`.

## Consequences

- A deploy that changes a checkpoint input fails the task at the first replay, if the handler gives
  the input. The operator sees `CheckpointInputConflictError`.
- A checkpoint without an input keeps the behavior of ADR 0005.
- Workhorse stores 64 characters for each checkpoint with an input, not the input. An operator
  cannot read the input from the fingerprint.
- Every SDK statement catalogue names `save_checkpoint_v2`, so the schema floor rises to 68.
- An input cannot hold a number larger than 2^53 - 1 in magnitude, such as a 64-bit identifier.
  Code that must check such a value gives it as a string.
- An SDK that adds the option must produce the RFC 8785 form. A JSON encoder that sorts keys by
  code point, or that writes numbers in another form, gives a different digest for some inputs.

## Rejected alternatives

### Store the input

The stored input would let an operator see what changed. But an input can be as large as a value,
and it can hold data that the result does not hold. A digest has a fixed size.

### Compute the digest in PostgreSQL

PostgreSQL could hash the canonical `jsonb` text. But the SDK compares the fingerprint before it
returns a stored value, without a round trip. It would have to reproduce the `jsonb` text form,
which is not a published standard.

### Refuse only an integer type above 2^53 - 1

Python, Ruby and Rust can tell an integer from a float, so they could refuse only a large integer.
TypeScript and Go cannot. One SDK would then give a digest for an input that another SDK refuses.

### Compare the input on every checkpoint

A required input would fail every task that stored a checkpoint before the deploy that adds the
input. An optional check lets code add the input safely.
