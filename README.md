# Workhorse

Workhorse is a durable job queue built from PostgreSQL tables and versioned SQL functions. Your
business write and its background job can commit in the same transaction, without another broker.

> **Public beta:** Workhorse is usable for evaluation and early production adoption, but 0.x minor
> releases may break compatibility, including the schema. There is no upgrade path between 0.x
> releases; ordered migrations begin at 1.0.0.

[Documentation](https://workhorse.run/docs) · [Quickstart](https://workhorse.run/docs/quickstart) ·
[Live demo](https://demo.workhorse.run) · [Compatibility](docs/compatibility.md)

## Why Workhorse

Applications often need a database change and a background job to succeed together. Workhorse
enqueues through the same PostgreSQL transaction, so a rollback cannot leave one without the other.

PostgreSQL owns queue state, scheduling, retries, recovery, and immutable history. Workers claim jobs
with fence tokens, so a worker that resumes after losing its lease cannot overwrite newer work.

Handlers receive at-least-once delivery. Workhorse records durable progress and outcomes, but external
effects still need stable provider idempotency keys or compensation.

## Run one job

Install the TypeScript package and its schema:

```bash
npm install @stablemates/workhorse
npx workhorse schema install
```

Install the schema during deployment. Runtime processes should verify compatibility instead of
attempting schema changes.

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

The [quickstart](https://workhorse.run/docs/quickstart) continues through failure and recovery. See
[worker processes](https://workhorse.run/docs/worker-processes) before deploying a worker.

## When it fits

Choose Workhorse when your application already depends on PostgreSQL and needs durable background
work that can share application transactions. Choose a dedicated broker when queue scale or
availability must be independent from the application database.

## Packages

- [`@stablemates/workhorse`](typescript/core) is the TypeScript client, worker runtime, schema CLI,
  and operator API that most TypeScript applications install.
- [`@stablemates/workhorse-drizzle`](typescript/drizzle),
  [`@stablemates/workhorse-prisma`](typescript/prisma),
  [`@stablemates/workhorse-typeorm`](typescript/typeorm), and
  [`@stablemates/workhorse-kysely`](typescript/kysely) enqueue through ORM-owned transactions.
- [`@stablemates/workhorse-dashboard`](typescript/dashboard) is the React operator dashboard and
  compatibility facade. Its server and type contract are also published for package composition.
- The [Python SDK](python) and [Go SDK](go) implement the same PostgreSQL protocol.

## Learn and operate

- [Guides](https://workhorse.run/docs) explain enqueue, workers, retries, durable execution, and
  integrations.
- [API reference](https://workhorse.run/docs/api) documents the public TypeScript surface.
- [Architecture](docs/architecture.md) defines exact protocol behavior and invariants.
- [Feature matrix](docs/features.md) separates supported, partial, and unsupported behavior.
- [Compatibility](docs/compatibility.md) defines supported runtimes, schema policy, and releases.
- [Operations](https://workhorse.run/docs/operations) covers health, retention, and maintenance.
- [Dashboard](https://workhorse.run/docs/dashboard) explains the operator UI and deployment boundary.
- [Changelog](CHANGELOG.md) records releases and required schema versions.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before sending a change, sign the [contributor
agreement](CLA.md), and use the development commands defined in [package.json](package.json).

## License

Workhorse is available under the [Apache License, Version 2.0](LICENSE). Attribution lives in
[NOTICE](NOTICE).
