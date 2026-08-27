# `@stablemates/workhorse`

The TypeScript client, worker runtime, schema tools, and operator API for the Workhorse PostgreSQL
durable execution protocol.

> **Public beta:** Workhorse is usable for evaluation and early production adoption, but 0.x minor
> releases may break compatibility, including the schema. There is no upgrade path between 0.x
> releases; ordered migrations begin at 1.0.0.

## Install

```bash
npm install @stablemates/workhorse
npx workhorse schema install
```

Install the schema during deployment. Runtime processes should verify compatibility instead of
attempting schema changes.

## Run one job

```ts
import { assertSchemaCompatible, Pool, Queue, Worker } from "@stablemates/workhorse";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await assertSchemaCompatible(pool);

const queue = new Queue(pool);
const worker = new Worker(queue).handle("email.welcome", async (payload: { to: string }, context) =>
  context.checkpoint("deliver", () => ({ deliveredTo: payload.to })),
);

await queue.enqueue("email.welcome", { to: "ada@example.com" });
await worker.runOnce(); // Production worker processes call `run()`.
await pool.end();
```

Handlers receive at-least-once delivery. Use stable provider idempotency keys around external effects;
named checkpoints prevent completed application stages from running after a later restart.

## Package boundary

This package owns the PostgreSQL schema, protocol client, worker runtime, CLI, and operator API. Run
schema changes as a deployment step; application and worker processes should only check compatibility.
ORM applications can add a provider package to enqueue through an existing application transaction.
Core has no telemetry vendor dependency. Applications that use OpenTelemetry install
`@stablemates/workhorse-otel`, configure their global SDK providers, and call
`registerOpenTelemetry()` during process startup.

## Next

- Follow the [quickstart](https://workhorse.run/docs/quickstart) and deploy
  [worker processes](https://workhorse.run/docs/worker-processes).
- Read the [API reference](https://workhorse.run/docs/api), [CLI guide](https://workhorse.run/docs/operations),
  and [compatibility policy](https://workhorse.run/docs/compatibility).
- Use the [operations guide](https://workhorse.run/docs/operations) for health, retention, and maintenance.
- Browse the [repository](https://github.com/stablemates/workhorse) or report a problem in
  [GitHub issues](https://github.com/stablemates/workhorse/issues).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
