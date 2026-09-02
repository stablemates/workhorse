# `@stablemates/workhorse`

The TypeScript client, worker runtime, schema tools, and operator API for the Workhorse durable job
queue for PostgreSQL.

> **Public beta:** Workhorse is usable for evaluation and early production adoption. A 0.x minor
> release may change behaviour, so read the changelog before you upgrade. It will not ask you to
> recreate your database: migrations are ordered, and inside a major line a migration only adds, so
> a running deployment upgrades in place.

An AI agent should read [the Workhorse documentation index](https://workhorse.run/llms.txt) first.

## Install

```bash
npm install @stablemates/workhorse
npx --package @stablemates/workhorse workhorse schema install
```

Install the schema during deployment. Runtime processes should verify compatibility instead of
attempting schema changes.

Requires Node.js 22 or 24 and PostgreSQL 15 through 18.

## Run one job

```ts
import { Admin, Pool, Queue, Worker } from "@stablemates/workhorse";

export async function runQuickstart(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const queue = new Queue(pool);
    const admin = new Admin(pool);
    const worker = new Worker(queue, { workerId: "quickstart-worker" }).handle(
      "welcome.send",
      async (payload) => ({ message: `Welcome, ${payload.name}!` }),
    );
    const jobId = await queue.enqueue("welcome.send", { name: "Ada" });
    await worker.runOnce();
    const job = await admin.getJob(jobId);
    if (job?.state !== "succeeded") throw new Error(`Quickstart job finished in ${job?.state}`);
    return { jobId, result: job.result };
  } finally {
    await pool.end();
  }
}
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
