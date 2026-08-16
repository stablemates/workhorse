<p align="center">
  <img alt="Workhorse — durable background jobs on PostgreSQL" src="./site/public/brand/workhorse-wordmark.png" width="320" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@workhorse/core"><img alt="npm version" src="https://shieldcn.dev/npm/@workhorse/core.svg?variant=secondary&mode=dark" /></a>
  <a href="https://github.com/stablemates/workhorse/stargazers"><img alt="GitHub stars" src="https://shieldcn.dev/github/stablemates/workhorse/stars.svg?variant=branded&mode=dark" /></a>
</p>

Durable background jobs on the PostgreSQL you already run. Enqueue inside your own transaction, let the database own leases, retries, deadlines, and schedules, and watch every attempt from an operator dashboard. No broker, no extension, no separate control plane.

- Transactional enqueue in your existing `pg`, Drizzle, Prisma, TypeORM, or Kysely transaction
- Fenced leases so only the current attempt owner can complete, fail, or heartbeat a job
- Durable execution: named checkpoints and lease-releasing waits that survive restarts
- PostgreSQL-owned retries, deadlines, execution timeouts, and cooperative cancellation
- Deploy-synchronized recurring jobs, with no extra scheduler process
- Immutable dead letters with audited redrive and retained lineage
- A packaged React operator dashboard that mounts on any framework, or runs standalone
- CLI for scaffolding, schema install, worker processes, and the dashboard

## Install

```bash
npm install @workhorse/core pg
```

Workhorse needs Node 22+ and PostgreSQL 15+. No PostgreSQL extension is required.

## Usage

```ts
import { Pool } from "pg";
import { installSchema, Queue, Worker } from "@workhorse/core";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await installSchema(pool);

const queue = new Queue(pool);
await queue.enqueue("email", { to: "person@example.com" });

const worker = new Worker(queue, { concurrency: 4 }).handle(
  "email",
  async ({ to }, { checkpoint, sleep }) => {
    // A checkpoint never runs twice, even after a restart.
    const delivery = await checkpoint("provider-delivery", async () => ({ deliveredTo: to }));

    // This releases the lease and the worker slot, then restarts the handler when it is due.
    await sleep("delivery-observation-window", 60_000);
    return delivery;
  },
);

await worker.runOnce();
```

Pass the active `PoolClient` as the fourth argument to `enqueue` to accept a job in the same transaction as your application writes.

## Dashboard

```ts
import { createDashboardHost } from "@workhorse/dashboard/server";
```

The host takes a `Request` and returns a `Response`, so it mounts on Hono, Next.js, SvelteKit, Nitro, Express, Connect, or Fastify. It needs only a database connection: workers register themselves in PostgreSQL, so the dashboard and the workers can be separate deployments.

## CLI

```bash
npx workhorse init              # scaffold a worker configuration
npx workhorse schema install    # install the schema into a clean database
npx workhorse worker            # run the workers as their own process
npx workhorse dashboard         # inspect any Workhorse database
```

## Packages

One package per boundary, so nothing you skip ends up in your dependency tree. New packages land regularly; the current set is:

| Package | What it gives you |
| --- | --- |
| `@workhorse/core` | Queue, worker runtime, schema installer, and CLI |
| `@workhorse/dashboard` | React operator dashboard and its framework-neutral host |
| `@workhorse/drizzle` | Enqueue inside a Drizzle transaction |
| `@workhorse/prisma` | Enqueue inside a Prisma interactive transaction |
| `@workhorse/typeorm` | Enqueue inside a TypeORM entity manager |
| `@workhorse/kysely` | Enqueue inside a Kysely transaction |
| `workhorse-pg` (PyPI) | Python enqueue client for Psycopg and asyncpg |

Each adapter exposes the same transaction boundary through its own transaction object, so the protocol stays identical across every client. A Go enqueue client is planned.

## Integrations

**Frameworks.** Enqueue is a query on your own connection, and the dashboard host takes a `Request` and returns a `Response`. So Next.js, Hono, Elysia, Express, Fastify, NestJS, TanStack Start, React Router, SvelteKit, Nuxt, Astro, and AdonisJS all mount the same way. Serverless runtimes such as Cloudflare Workers and Vercel Functions enqueue jobs; the workers stay on a persistent host.

**PostgreSQL hosts.** Workhorse installs one schema and needs no extension, so it runs on Neon, Supabase, PlanetScale, Railway, Render, Fly, Google Cloud SQL, Azure, RDS, or your own server.

Per-integration guides live at **[workhorse.run/docs/integrations](https://workhorse.run/docs/integrations)**.

## Documentation

Full docs live at **[workhorse.run](https://workhorse.run)**. Good places to start:

- [Durable execution](https://workhorse.run/docs/durable-execution)
- [Operations](https://workhorse.run/docs/operations)
- [Dashboard](https://workhorse.run/docs/dashboard)

Deeper references live in this repository:

- [`docs/architecture.md`](docs/architecture.md): boundaries, data model, lifecycle, fencing, and invariants
- [`docs/features.md`](docs/features.md): the Supported, Partial, and Not Supported matrix
- [`docs/compatibility.md`](docs/compatibility.md): supported Node.js and PostgreSQL versions and release process
- [`docs/benchmarking.md`](docs/benchmarking.md): benchmark commands, scale ladder, and how to read the results
- [`CHANGELOG.md`](CHANGELOG.md): released versions and the schema version each one requires

## Correctness

Accepted jobs are durable in PostgreSQL. Handlers run outside database transactions and are **at least once**. Only the current unexpired worker and fence pair can heartbeat, complete, or fail an attempt, and a stale worker cannot commit after recovery. PostgreSQL cannot make an HTTP call, an email, or a payment exactly once, so external effects still need stable idempotency keys, an outbox, or compensation.

## Development

Requirements: Node.js 22+, pnpm, Python 3.10+, uv, and PostgreSQL 15+.

```bash
pnpm install
pnpm db:reset:all
pnpm check
```

Local tooling keeps four databases separate — `workhorse_dev`, `workhorse_test`, `workhorse_bench`, and `workhorse_demo`. Each destructive command verifies the matching suffix and refuses remote hosts.

## Sponsors

Workhorse is supported by companies that keep durable execution on PostgreSQL practical and maintained. Want your logo here? **[Become a sponsor →](https://github.com/sponsors/stablemates)**

<!-- Pulled automatically from GitHub Sponsors via shieldcn.dev — logos, names, and avatars are fetched live, and new sponsors appear on their own. Tiers follow GitHub Sponsors amounts: `special=` pins the top tier ($100+/mo) into the larger "Special Sponsors" row; everyone else renders in the "Sponsors" row below. -->
<p align="center">
  <a href="https://github.com/sponsors/stablemates">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/sponsors/stablemates.svg?title=false&mode=dark&preset=surface" />
      <source media="(prefers-color-scheme: light)" srcset="https://shieldcn.dev/sponsors/stablemates.svg?title=false&mode=light&preset=surface" />
      <img alt="Workhorse sponsors" src="https://shieldcn.dev/sponsors/stablemates.svg?title=false&mode=dark&preset=surface" width="820" />
    </picture>
  </a>
</p>

## Star History

<p align="center">
  <a href="https://github.com/stablemates/workhorse/stargazers"><img alt="Star history" src="https://shieldcn.dev/chart/github/stars/stablemates/workhorse.svg?mode=dark" /></a>
</p>
