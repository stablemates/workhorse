# Keeping bad or sensitive data out of jobs

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

Payload validation happens before enqueue writes anything. Result validation happens before
completion removes the active lease. If a handler returns an invalid result, the worker follows the
normal failure and retry path instead of recording a successful outcome.

## Keep old versions while old jobs can run

Each job stores the version selected when PostgreSQL accepted it. Claims carry that version back to
the worker, so a new deployment validates an old job's result against the old contract.

Add a new entry and move `currentVersion` when the shape changes. Keep the previous entry until no
live or redrivable job can still carry it. A worker that receives a version it did not configure
fails safely with `JobContractUnavailableError`.

Operator reads do not run validators. Historical JSON remains readable even if the application no
longer accepts that shape for new jobs.

## Bound storage and hide sensitive fields

`defaultMaxPayloadBytes` and `defaultMaxResultBytes` set queue-wide ceilings. A
`JobContractVersion` can override them with `maxPayloadBytes` and `maxResultBytes`. PostgreSQL checks
its canonical JSON representation before the durable write, so every client gets the same decision.

`sensitivePayloadKeys` and `sensitiveResultKeys` name top-level object fields. Handlers receive the
raw payload, but job lookup, listing, dead letters, and dashboard detail remove those fields. Traces
and contract errors carry identity and outcome metadata without payload or result values.

## Next

- [210-enqueue-idempotency.md](210-enqueue-idempotency.md) — how a contract change affects replay
- [220-schedules.md](220-schedules.md) — how recurring definitions capture a contract
- [310-workers.md](310-workers.md) — how invalid results enter the failure path

---

Exact fields, limits, and failure behavior:
[`architecture.md`](../architecture.md#job).
