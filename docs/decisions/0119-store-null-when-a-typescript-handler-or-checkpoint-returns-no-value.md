# ADR 0119: Store null when a TypeScript handler or checkpoint operation returns no value

- **Status:** Accepted
- **Date:** 2026-11-10
- **Amends:** [ADR 0005](0005-explicit-durable-checkpoints.md) (the JSON result of a checkpoint)
- **Issues:** SM-1969, SM-1930, SM-1950

## Context

A handler and a checkpoint operation can return no value. Each language has its own form of "no
value": `None` in Python, `nil` in Go and Ruby, `null` in the JVM and .NET, and `()` in Rust. Those
six SDKs store JSON `null` for it.

The TypeScript API required a JSON value. `Handler` returned `TResult extends Json`, and
`HandlerContext.checkpoint` returned `TValue extends Json`. ADR 0005 requires a JSON result for a
checkpoint. Thus `undefined` was outside the contract, but a JavaScript handler or an operation
typed `any` could still return it.

**Example.** A handler sends a welcome email in a checkpoint:
`await ctx.checkpoint("welcome", () => mailer.welcome(payload.to))`. The `mailer.welcome` call
resolves to `undefined`.

1. The operation sends the email.
2. `JSON.stringify(undefined)` gives no text, so the save throws a `TypeError`. Nothing is stored.
3. The attempt fails, and the retry policy schedules a new attempt.
4. The new attempt finds no checkpoint, so it sends the email again.

This repeats for each attempt, up to `maxAttempts`. A handler that returns `undefined` fails each
attempt in the same way, because the result has no JSON text.

## Decision

TypeScript stores JSON `null` when a handler returns `undefined` and when a checkpoint operation
returns `undefined`, as the other six SDKs do.

1. **A handler result.** If a handler returns `undefined`, the worker completes the task with the
   result `null`. The `Handler` type does not change: it still returns `Promise<TResult> | TResult`.
   A JavaScript handler, or a handler typed `any`, can return `undefined`, and the run time stores
   `null`. A typed TypeScript handler with no result writes `return null`.
2. **A checkpoint operation.** If the operation returns `undefined`, the checkpoint stores JSON
   `null` and returns `null`. A retry reads the checkpoint and does not run the operation again.
   `HandlerContext.checkpoint` has a second signature for an operation that returns `void`, and that
   signature returns `Promise<null>`. A call with an explicit value type that excludes `null`, such as
   `checkpoint<{ id: string }>`, still requires a value.
3. **Only the top level changes.** An `undefined` property of an object and an `undefined` member of
   an array keep the JSON rules: `JSON.stringify` leaves out the property and writes the member as
   `null`.
4. **The handler replay follows the worker.** `replayHandler` reports the result `null` for a
   handler that returns `undefined`, and it records `null` for a new checkpoint whose operation
   returns `undefined`.

Each other value must be JSON. A value that JSON cannot store as given, such as `NaN` or a `Map`,
fails with a `TypeError` (SM-1930, SM-1989). For a checkpoint, that error comes after the operation
ran, so a retry runs the operation again.

## Consequences

- The email of the example goes out one time. A handler that returns no value succeeds with a
  `null` result.
- The seven SDKs store the same value for "no value". `protocol/v1/runtime.json` holds two result
  cases in `json-values-survive-the-payload-and-result-round-trip`, one for JSON `null` and one for
  "no value". The fixture `checkpoint-operation-with-no-value-stores-null-and-runs-once` requires
  one operation run and a stored JSON `null`. All seven runners run both fixtures.
- A TypeScript caller cannot tell from the stored result whether the handler returned `null` or
  `undefined`. No SDK keeps that difference.
- Code that typed a checkpoint operation as `() => Promise<void>` compiled with an error before.
  Now it compiles, and the returned promise is `Promise<null>`. That signature is new, so each
  checkpoint call that compiled before compiles with the same types.
- The decision of SM-1969 to widen the types to accept `void` holds for the checkpoint only. A
  `Handler` that returns `void` would also widen the type that a caller of a handler reads. For
  example, a wrapper that returns `await handler(payload, context)` as `Promise<Json>` would not
  compile. Thus a change of the `Handler` type is a breaking change, and a follow-up issue owns it
  for a later major line.
