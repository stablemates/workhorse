# Installation

> Add the core package, install its PostgreSQL schema, and check compatibility before a process starts.

Workhorse stores durable state in your database, so installing it is a schema change — and schema
changes deserve a deliberate deployment step, not a side effect of the first process to boot. This
page separates the two actions: installation, which creates database objects once, and the startup
check every runtime process should make instead.

## Requirements

- Node.js 22 or newer. CI exercises the even-numbered majors 22 and 24.
- PostgreSQL 15 or newer, with no extension. CI exercises majors 15 through 18.
- An ESM application. Every published package is ESM and ships type declarations.

`installSchema` refuses an older PostgreSQL up front, naming the server's version, rather than
failing partway through with a syntax error that reads like a Workhorse bug.

## Add the package

Install `@workhorse/core` alongside the PostgreSQL client your application already uses.

```bash
npm install @workhorse/core pg
```

## Which package do you need?

Most applications need the first one only. Add an adapter when you want to enqueue inside your
ORM's own transactions, and the dashboard when an operator needs to see the queue.

- **`@workhorse/core`**: `Queue`, `Worker`, schema tools, process orchestration, and the CLI.
- **`@workhorse/dashboard`**: the operator interface and its framework-neutral server host.
- **`@workhorse/drizzle`**: adapts Drizzle databases and transactions to the core `Queryable` protocol.
- **`@workhorse/prisma`**: adapts Prisma clients and interactive transactions.
- **`@workhorse/typeorm`**: adapts TypeORM data sources and transactional entity managers.
- **`@workhorse/kysely`**: adapts Kysely databases and transactions.

Install an adapter only when that integration belongs in the same process.

If you are adding Workhorse to an existing project, `workhorse init` can scaffold the wiring. It
inspects the project, writes a worker configuration, and prints a dashboard mount — but it leaves
your routes and package manifest alone.

```bash
npx workhorse init
```

## Give Workhorse a database

Workhorse creates every object inside a schema named `workhorse`. The connecting role must be able
to create that schema plus its tables, indexes, partitions, and functions.

Your process supplies the connection through its normal configuration — typically a `pg` `Pool`
built from `DATABASE_URL`. The CLI accepts `--database-url` and the documented Workhorse or
application environment variables.

## Install the schema deliberately

When the target database is new, install from a deployment step. `schema status` then reports the
installed version against what the runtime expects.

```bash
npx workhorse schema install
npx workhorse schema status
```

The same step is available from deployment code as `installSchema`.

```ts
import { Pool } from "pg";
import { installSchema } from "@workhorse/core";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await installSchema(pool);
await pool.end();
```

`installSchema` targets a clean database. If a `workhorse` schema already exists, it proceeds only
when that schema carries exactly the current version and no legacy relations; anything mixed,
unversioned, or older is refused. It never treats installation as an upgrade path.

## Migrate an installed schema

Run `migrateSchema` from a deployment step before processes from the new release start. It applies
the package's immutable, forward-only migration steps in order.

```ts
import { migrateSchema } from "@workhorse/core";

await migrateSchema(pool);
```

The migration refuses a missing schema, a version below its supported baseline, a newer version,
or a gap in the ordered plan. The current pre-release line has no older supported source, so an
older development schema still requires a reset until a public release adds the first migration.

## Check before a runtime starts

Application and worker processes should verify the schema, never install it. That split keeps the
destructive authority to create database objects out of every long-lived process.

```ts
import { assertSchemaCompatible } from "@workhorse/core";

await assertSchemaCompatible(pool);
```

`assertSchemaCompatible` reads the installed version without creating or changing anything. If the
schema is missing, it says so and points at the installation step; if the version differs from the
runtime's, it names both numbers.

When you want the raw values instead of an assertion — for a health endpoint, for example — use
`readSchemaVersion` and compare against the exported `WORKHORSE_SCHEMA_VERSION` constant.

```ts
import { readSchemaVersion, WORKHORSE_SCHEMA_VERSION } from "@workhorse/core";

const installed = await readSchemaVersion(pool); // number, or null when absent
console.log({ installed, expected: WORKHORSE_SCHEMA_VERSION });
```

For the server side of the same question, `readPostgresSupport` classifies the connected PostgreSQL
as supported and tested, supported but untested, or unsupported.

## Next

- [Quickstart](/docs/quickstart) — create a queue and run your first handler
- [Core concepts](/docs/concepts) — understand state, ownership, and delivery
- [Compatibility](/docs/compatibility) — the tested support boundary in detail

---

Exact schema requirements and installation boundaries:
[architecture reference](https://github.com/stablemates/workhorse/blob/main/docs/architecture.md#operational-limits).
