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

## Amendment: a second child set ends the task as a child limit (2026-11-11)

A task holds one child set. `create_children_v1` answers `conflict` when a handler asks for a
second set, and each SDK raised its replay conflict error. That error says that the handler code
changed, which is not true. `create_children_v2` answers `limit_exceeded` when the activation that
created or joined the set asks for another set, as migration 0054 does for a second single child
(SM-1956). Each SDK raises its child limit error for that answer. A second set names other children than the stored set. The stored names with a changed request stay a
replay conflict, also in the same activation, so an SDK can replay them under the stored contract
versions.

A second child set stays terminal: the worker settles it with the terminal retry delay, as it
settled the conflict before. Each SDK marks that limit error internally, and the replay conflict
check accepts only the marked error. Thus the result of each released case does not change, and
only the diagnosis changes.

Each other child limit refusal follows the retry policy, as before: the second single child, a set
of more than 100 children, and `result_too_large`. `docs/guides/130-durable-waits.md` states that
rule, and the `child-limit` case of `protocol/v1/runtime.json` holds it in each SDK.

Open question: a deterministic handler gets the same child limit answer on each attempt, so a retry
of such a refusal cannot succeed. Whether each child limit refusal and `result_too_large` must end
the task with no retry is a product decision for a later change.

## Amendment: an oversized checkpoint value is terminal (2026-11-11)

`save_checkpoint_v2` raised a plain exception for a value above 1,048,576 bytes of jsonb text. No
SDK mapped it to an error class, so the worker retried the task by its policy. The SDK runs the
operation of a checkpoint before it saves the value. Thus each retry ran the operation again, with
its effects, and no attempt could store the value (SM-1982).

1. `save_checkpoint_v3` answers the status `value_too_large`, with `value_bytes` and `max_bytes`,
   and stores nothing. It gives this answer after the lease check and after the check of a stored
   name. `save_checkpoint_v2` keeps its exception, so a worker of an earlier release sees no change.
2. Each SDK raises a typed error for that status: `CheckpointValueSizeLimitError` in TypeScript,
   Python, Go, Rust, and Ruby, and `CheckpointValueSizeLimitException` in the JVM and .NET.
3. The worker fails the task without a retry and keeps the current attempt, as for the conflict
   classes of point 6. It finds the error in the cause chain in the same way.
4. No SDK measures the value. The limit counts the canonical jsonb text, which only PostgreSQL
   produces.

An oversized handler result is different. It follows the retry policy, because a retry of that
handler replays its stored checkpoints and repeats no checkpoint operation. An oversized checkpoint
value is stored by no attempt, so its operation runs on each attempt.

An operator who sees the error corrects the handler, so that the value is smaller, and then redrives
the task. A redrive starts a new task, so its handler runs the operation again.

[Data model: `task_checkpoint`](../architecture/data-model.md#task_checkpoint) owns the statuses and
the settlement rule.
