# How do I keep bad or sensitive data out of tasks?

A producer can enqueue malformed data, and an operator screen can expose fields that handlers need
but people should not see. Payload contracts reject the malformed value and carry a redaction policy
with every accepted task.

## Define contracts where you create the queue

`QueueOptions.contracts` groups JSON Schema documents under each task type. New tasks receive
`currentVersion`, while PostgreSQL retains older documents for tasks accepted by an earlier deploy.

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
```

Call `queue.syncContracts()` during application startup. Python exposes `sync_contracts`, and Go
exposes `SyncContracts`. PostgreSQL inserts each version once and keeps the current version in a
separate policy row, so an operator override survives the next deploy.

After synchronization, the TypeScript client caches the selected document for each task type. If an
operator changes the selected version, PostgreSQL reports the stale selection so the client can
refresh the document and validate the enqueue again.

Each SDK rejects keywords outside the shared profile before compiling a schema. References can
target bundled definitions in the same document, while remote references and custom keywords are
rejected. Formats remain annotations, so an email format does not create a language-specific gate.

The queue validates a payload before enqueue writes anything. The worker validates a result before
completion removes the active lease. If a handler returns an invalid result, the worker follows the
normal failure and retry path instead of recording a successful outcome.

## Keep old versions while old tasks can run

Each task stores the version selected when PostgreSQL accepted it. When a worker claims the task,
PostgreSQL returns that version. The worker loads that immutable document and caches it by task type
and version, so a new deployment validates its result against the old contract.

When the shape changes, add a new entry and move `currentVersion`. Once a version has been synced,
PostgreSQL retains its immutable document, so tasks accepted under it keep validating even after you
drop that entry from application config. A worker that can find a task's version neither in
PostgreSQL nor in its own config fails safely with `TaskContractUnavailableError`.

Operator reads do not run validators. Historical JSON remains readable even if the application no
longer accepts that shape for new tasks.

## Bound storage and hide sensitive fields

Queue defaults set size ceilings. A `TaskContractVersion` can override them. PostgreSQL checks its
canonical JSON representation before the durable write, so every client gets the same decision.

`sensitivePayloadKeys` and `sensitiveResultKeys` name top-level object fields. Handlers receive the
raw payload, but task lookup, listing, dead letters, and dashboard detail remove those fields. If a
contract names sensitive fields, Workhorse also replaces handler error details before tracing or
persistence. Contract errors carry identity and outcome metadata without payload or result values.

## Next

- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — how a contract change affects replay
- [220-schedules.md](220-schedules.md) — how recurring definitions capture a contract
- [310-workers.md](310-workers.md) — how invalid results enter the failure path

---

Exact fields, limits, and failure behavior:
[`architecture.md`](../architecture.md#task).
