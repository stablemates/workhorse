# How do I keep bad or sensitive data out of jobs?

A producer can enqueue malformed data, and an operator screen can expose fields that handlers need
but people should not see. Payload contracts reject the malformed value and carry a redaction policy
with every accepted job.

## Define contracts where you create the queue

`QueueOptions.contracts` groups versions under each job type. New jobs receive `currentVersion`, while
older versions stay available for jobs accepted by an earlier deployment.

```ts
const queue = new Queue(pool, "default", {
  contracts: {
    "mail.send": {
      currentVersion: "mail-current",
      versions: {
        "mail-current": {
          validatePayload: (value) =>
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            typeof value.recipient === "string",
          validateResult: (value) =>
            typeof value === "object" && value !== null && !Array.isArray(value),
          sensitivePayloadKeys: ["accessToken"],
          sensitiveResultKeys: ["providerReceipt"],
        },
      },
    },
  },
});
```

A validator accepts by returning `true`. Returning `false` or throwing rejects the value with a
safe `JobContractValidationError`; Workhorse does not copy the rejected value or validator message
into that error.

The queue validates a payload before enqueue writes anything. The worker validates a result before
completion removes the active lease. If a handler returns an invalid result, the worker follows the
normal failure and retry path instead of recording a successful outcome.

## Keep old versions while old jobs can run

Each job stores the version selected when PostgreSQL accepted it. When a worker claims the job,
PostgreSQL returns that version, so a new deployment validates its result against the old contract.

When the shape changes, add a new entry and move `currentVersion`. Until no live or redrivable job
can still carry the previous entry, keep it configured. A worker that receives an unavailable version
fails safely with `JobContractUnavailableError`.

Operator reads do not run validators. Historical JSON remains readable even if the application no
longer accepts that shape for new jobs.

## Bound storage and hide sensitive fields

`defaultMaxPayloadBytes` and `defaultMaxResultBytes` set queue-wide ceilings. A
`JobContractVersion` can override them with `maxPayloadBytes` and `maxResultBytes`. PostgreSQL checks
its canonical JSON representation before the durable write, so every client gets the same decision.

`sensitivePayloadKeys` and `sensitiveResultKeys` name top-level object fields. Handlers receive the
raw payload, but job lookup, listing, dead letters, and dashboard detail remove those fields. If a
contract names sensitive fields, Workhorse also replaces handler error details before tracing or
persistence. Contract errors carry identity and outcome metadata without payload or result values.

## Next

- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — how a contract change affects replay
- [220-schedules.md](220-schedules.md) — how recurring definitions capture a contract
- [310-workers.md](310-workers.md) — how invalid results enter the failure path

---

Exact fields, limits, and failure behavior:
[`architecture.md`](../architecture.md#job).
