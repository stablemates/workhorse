# How do I keep bad or sensitive data out of tasks?

<!-- scenario-names: mail-v2, recipient, mail-current, mail.send -->

Your application enqueues a task. The task carries data in its payload. When the handler is
complete, it can return a result. A payload contract is a set of rules for the payload and the
result of one task type. Workhorse compares the data with these rules. If the data does not obey
the rules, Workhorse stops it.

Without a payload contract, Workhorse accepts bad data. The task then fails later, when a worker
runs it. With a payload contract, the error occurs immediately, in the code that enqueued the task.

## Check the payload when you enqueue a task

**Example.** The task type `mail.send` sends one email. Its payload must have the field `recipient`.
Your application has a bug, and it sends `{ "to": "ada@example.com" }`. This payload has no
`recipient` field. Workhorse does not accept the task, and your code gets an error. Workhorse does
not save the task.

To add a payload contract:

1. Write the rules as a JSON Schema document.
2. Put the document in `QueueOptions.contracts` when you create the queue.
3. Call `queue.syncContracts()` when your application starts.

```ts
const queue = new Queue(pool, "default", {
  contracts: {
    "mail.send": {
      currentVersion: "mail-current",
      versions: {
        "mail-current": {
          payloadSchema: {
            type: "object",
            required: ["recipient"],
            properties: { recipient: { type: "string" } },
          },
          resultSchema: { type: "object" },
          sensitivePayloadKeys: ["accessToken"],
          sensitiveResultKeys: ["providerReceipt"],
        },
      },
    },
  },
});
await queue.syncContracts();
```

Step 3 saves the rules in PostgreSQL. Then all parts of your application use the same rules. A new
task uses the version that `currentVersion` names, and the task keeps that version.

If the data does not obey the rules, Workhorse raises `TaskContractValidationError`. The error shows
the task type and the version. It also shows if the payload or the result failed. The error does not
contain the bad data.

Workhorse also checks the result. If the handler returns a bad result, the attempt fails. Then the
[retry](110-retries.md) rules apply.

<details>
<summary>Reference: contract definitions</summary>

**`QueueOptions`**

| Field                    | Rule                                       |
| ------------------------ | ------------------------------------------ |
| `contracts`              | Maps a task type to a `TaskTypeContracts`. |
| `defaultMaxPayloadBytes` | Queue-wide payload size ceiling.           |
| `defaultMaxResultBytes`  | Queue-wide result size ceiling.            |

**`TaskTypeContracts`** has `currentVersion` and a `versions` record of `TaskContractVersion`.

**`TaskContractVersion`**

| Field                  | Rule                                                |
| ---------------------- | --------------------------------------------------- |
| `payloadSchema`        | Optional. A JSON Schema Draft 2020-12 document.     |
| `resultSchema`         | Optional. A JSON Schema Draft 2020-12 document.     |
| `maxPayloadBytes`      | Optional. Overrides the queue's payload ceiling.    |
| `maxResultBytes`       | Optional. Overrides the queue's result ceiling.     |
| `sensitivePayloadKeys` | Optional. Top-level payload keys hidden from reads. |
| `sensitiveResultKeys`  | Optional. Top-level result keys hidden from reads.  |

**Synchronization.** TypeScript calls `queue.syncContracts()`. Python, Rust, and Ruby call
`sync_contracts`, and Go calls `SyncContracts`. `sync_contract_definitions_v1` inserts immutable
`(task_type, version)` rows into `contract_definition`.

**Validation errors.** `TaskContractValidationError` carries the task type, the contract version,
and whether the payload or the result failed. It keeps neither the value nor the library
diagnostic.

More detail: [Data model: Contract definitions and policy](../architecture/data-model.md#contract-definitions-and-policy).

</details>

## Change the rules

Each set of rules has a version name, for example `mail-current`. Each task keeps the version that
Workhorse used when it accepted the task.

A task can wait in the queue while you deploy new code. For example:

1. Workhorse accepts a `mail.send` task with the version `mail-current`.
2. You deploy the version `mail-v2`.
3. The handler completes the old task.
4. Workhorse checks the result with `mail-current`, not with `mail-v2`.

Thus, a new version does not cause old tasks to fail.

To change the rules:

1. Add a new version.
2. Set `currentVersion` to the name of the new version.

Do not change a version after you sync it. Workhorse rejects the change.

You can remove an old version from your code. PostgreSQL keeps a copy for the tasks that use it. If
a worker cannot find the version of a task, the attempt fails with `TaskContractUnavailableError`.

When you read a task, Workhorse does not apply the rules. Thus, you can always read old payloads.

<details>
<summary>Reference: versions and the cached selection</summary>

**Immutability.** A different schema, limit, or redaction value for a synced `(task_type, version)`
raises `contract documents are immutable; publish a new version`.

**Selection.** `contract_policy` stores `current_version`, `application_current_version`, and
`operator_override` separately. Application sync updates `application_current_version`. It changes
`current_version` only when `operator_override` is false.

**At completion.**

- `claim_v1` returns the persisted `contractVersion`, `resultMaxBytes`, and `redactErrorDetails`.
- Completion caches the document by `(task_type, contract_version)`. It does not consult
  `current_version`.
- A missing retained version becomes `TaskContractUnavailableError`.
- `Worker` handles a validation or unavailable error through the ordinary fenced failure and retry
  path.

**Stale cache at enqueue.** The client caches each current definition by `task_type`.

1. If a cached `contractVersion` differs from `contract_policy.current_version`, `enqueue_many_v1`
   returns one internal row with outcome `contract_mismatch` and the affected `taskTypes`. The
   client reloads those definitions, revalidates the batch, and retries once.
2. If a cached definition raises `TaskContractValidationError` or `TaskValueSizeLimitError`, the
   client reloads that task type's definition once and validates again. The second result stands.

Child-task creation and `syncSchedules` use the same path.

More detail: [Data model: Contract definitions and policy](../architecture/data-model.md#contract-definitions-and-policy)
and [Data model: Contract validation at enqueue and completion](../architecture/data-model.md#contract-validation-at-enqueue-and-completion).

</details>

## Limit the size of the data

PostgreSQL stores each payload and each result, so each one has a maximum size.

- To set the maximum for one queue, use `defaultMaxPayloadBytes` and `defaultMaxResultBytes`.
- To set the maximum for one version, use `maxPayloadBytes` and `maxResultBytes`.

If a payload is too large, Workhorse raises `TaskValueSizeLimitError` and does not accept the task.
If a result is too large, the attempt fails.

PostgreSQL cannot store some characters, for example the NUL character. If a result contains one of
these characters, the attempt fails. In all of these cases, the worker continues to run.

<details>
<summary>Reference: size limits and storable results</summary>

**Limits.** `payload_max_bytes` and `result_max_bytes` default to 1,048,576 bytes. A configured
value can be up to 16,777,216 bytes.

**Measurement.** PostgreSQL measures `octet_length(value::text)` after jsonb canonicalization. That
text puts a space after each `:` and `,` and writes numbers without an exponent. The SDKs measure
the same text.

**Enforcement.**

- `enqueue_batch_v1` rejects an oversized payload before it inserts any task, history, idempotency,
  or notification row.
- `complete_v1` checks the persisted result limit before it deletes the active runtime.
- An oversized value raises `TaskValueSizeLimitError` with the actual and allowed byte counts.
- An oversized result raises `TaskValueSizeLimitError` in the TypeScript, Go, Python, and Rust
  workers, and `ValueSizeLimitError` in the Ruby worker. The retry policy applies.
- In Python, a `NaN` or infinite number in a result raises `ValueError`.

**Unstorable results.** jsonb refuses `\u0000` (SQLSTATE `22P05`) and an unpaired UTF-16 surrogate
escape (SQLSTATE `22P02`). The Go, Python, TypeScript, and Ruby workers check for both. The Rust
worker checks for NUL only, because a Rust `String` cannot hold an unpaired surrogate. A refused
result fails the attempt through `fail_v1` with this message:

`<task type> result contains a NUL character or an unpaired surrogate, which PostgreSQL jsonb cannot store`

The message carries no part of the value. On the fast tier, the refused result never joins the
completion batch, so the other results in the batch still complete.

More detail: [Data model: Value size limits](../architecture/data-model.md#value-size-limits) and [Data model: Results jsonb cannot store](../architecture/data-model.md#results-jsonb-cannot-store).

</details>

## Hide secret fields

A payload can contain a secret, for example an access token. The handler needs the secret. The
people who look at the dashboard do not need it.

To hide a field of the payload, put its name in `sensitivePayloadKeys`. To hide a field of the
result, use `sensitiveResultKeys`.

The handler gets the full payload. Task lookup, task lists, dead letters, and the dashboard do not
show the hidden fields.

An error message can also contain a secret. If a payload contract hides a field, Workhorse replaces
the error details of a failed attempt with a fixed message. It does this before it stores or traces
the error.

<details>
<summary>Reference: redaction keys</summary>

- Each key list holds at most 50 unique top-level object keys of 1 to 200 characters.
- `claim_v1` returns the raw payload to the handler.
- `workhorse.redact_top_level_keys_v1` removes the keys for `Admin.getTask`, `Admin.listTasks`,
  dead-letter listing, and dashboard task detail.
- Scalar and array values pass through, because top-level key redaction applies only to objects.
- If either key list is non-empty, `workhorse.redact_error_details_v1` substitutes the name
  `RedactedTaskError` and the message `Task handler failed; details redacted`. It does so before
  `fail_v1` writes any error. `Worker` applies the same rule before it records the exception in
  OpenTelemetry.

More detail: [Data model: Redaction keys](../architecture/data-model.md#redaction-keys).

</details>

## Use only the permitted schema features

Workhorse has SDKs for TypeScript, Python, Go, Rust, and Ruby. All SDKs must get the same answer for
the same data. Some JSON Schema features give different answers in different languages. Workhorse
does not permit these features:

- `pattern` and `patternProperties`. Each language reads text patterns differently. Check the text
  format in your handler.
- References to other files.
- Custom keywords, and the other keywords that the reference lists.

A `$ref` must point to a part of the same schema: the full schema `#`, or an entry of the root
`$defs`.

You can use `format`, for example `"format": "email"`. But `format` does not check the value.

If the rules use a feature that Workhorse does not permit, the SDK shows an error when your
application starts.

<details>
<summary>Reference: contract schema profile</summary>

**Accepted.** Draft 2020-12 core, applicator, validation, and metadata keywords. `format` produces
annotations and never rejects an instance.

**References.**

- `$ref` must be `#` or `#/$defs/<name>`, where `<name>` is an own key of the root `$defs`.
- `$defs` may appear only on the root schema.
- Each `$defs` key must match `^[A-Za-z_][-A-Za-z0-9._]*$`.
- `$anchor` is rejected at any depth. A property named `$anchor` stays valid.

**Rejected keywords.** Remote references, custom keywords and vocabularies, `$dynamicRef`,
`$dynamicAnchor`, `unevaluatedProperties`, `unevaluatedItems`, `pattern`, and `patternProperties`.
A property named `pattern` stays valid.

**Compilers.** TypeScript uses Ajv with `strict: false` and `strictNumbers: true`. Python uses
`Draft202012Validator`. Go uses `santhosh-tekuri/jsonschema`. `strictNumbers` rejects NaN and the
infinities in an instance.

More detail: [Data model: Contract schema profile](../architecture/data-model.md#contract-schema-profile).

</details>

## Next

- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — how a contract change affects replay
- [220-schedules.md](220-schedules.md) — how recurring definitions capture a contract
- [310-workers.md](310-workers.md) — how invalid results enter the failure path

---

Exact fields, limits, and failure behavior:
[`architecture/data-model.md`](../architecture/data-model.md#task).
