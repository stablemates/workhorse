# ADR 0045: Make each README an entry point

- **Status:** Accepted
- **Date:** 2026-08-26
- **Related:** [WH-441](https://app.plane.so/techprogress/browse/WH-441/)

## Context

The root README tries to serve new users, maintainers, operators, and evaluators in one document.
Its feature inventory and protocol details hide the first successful path through the product.

The website already explains the product and owns guided documentation. The repository also keeps
precise architecture, decisions, research, and maintainer evidence that do not belong on a landing
page.

Published npm packages have inconsistent READMEs. The core package redirects readers elsewhere,
while the provider packages include enough code to begin. A registry reader should not need to
discover the monorepo before learning what the package does.

The issue described the packages as MIT. [ADR 0040](0040-apache-2-and-contributor-agreement.md)
superseded that premise before this decision. Published packages now use Apache-2.0.

## Decision

The root README is the repository entrance. It explains what Workhorse is, why PostgreSQL ownership
matters, who should use it, and how to run one TypeScript job. It then routes readers to the website,
the other language SDKs, the precise reference, and contributor material.

Keep the root README near 200 lines. The opening screen contains the product definition and public
beta notice. A short first-run path follows before any feature inventory.

The website owns the canonical public explanation, installation walkthroughs, guides, API reference,
integrations, examples, and limitations. Source documents under `docs/` own exact behavior,
architecture, decisions, benchmarks, and maintainer evidence.

Remove the long feature catalogue, development runbook, diagnostics, correctness contract, and
competitor baseline from the root README. Link to their existing owners instead of preserving
abridged copies.

### Root README prototype

The final rewrite should follow this shape. The prose is deliberately rough; the order and ownership
are the decision this prototype preserves.

```markdown
# Workhorse

Workhorse is a durable job queue built from PostgreSQL tables and versioned SQL functions. Your
business write and its background job can commit in the same transaction.

> **Public beta:** Workhorse is usable for evaluation and early production adoption, but 0.x minor
> releases may break compatibility, including the schema. There is no upgrade path between 0.x
> releases; ordered migrations begin at 1.0.0.

[Documentation](https://workhorse.run/docs) · [Quickstart](https://workhorse.run/docs/quickstart) ·
[Live demo](https://demo.workhorse.run) · [Compatibility](docs/compatibility.md)

## Why Workhorse

Explain the transactional enqueue promise, PostgreSQL-owned state, fenced recovery, and immutable
history in three short paragraphs. State that handler delivery is at least once.

## Run one job

Install `@stablemates/workhorse`, install the schema as a deployment step, then show one verified
`Queue` and `Worker` example. Link to the website for Python, Go, production worker processes, and
the full failure-and-recovery walkthrough.

## When it fits

Choose Workhorse when the application already depends on PostgreSQL and needs durable background
work without another broker. Choose a dedicated broker when queue scale or availability must be
independent from the application database.

## Packages

List the TypeScript core, dashboard, four ORM providers, Python SDK, and Go SDK. Explain which one a
reader installs rather than listing internal package boundaries.

## Learn and operate

Link to the guides, API reference, architecture reference, feature matrix, compatibility policy,
changelog, and dashboard. Do not duplicate their contents.

## Contributing

Link to `CONTRIBUTING.md`, the development commands, and the contributor agreement.

## License

Apache-2.0. Link to `LICENSE` and `NOTICE`.
```

### Published package README contract

Every published package README contains these elements in this order:

1. The exact package name and one sentence stating what it provides.
2. The public beta notice, before installation or API claims.
3. An install command for that package.
4. A verified minimal usage example for its intended reader.
5. The package boundary, including who owns database resources and schema changes where relevant.
6. Links to its focused website page, the API reference, the repository, and issue reporting.
7. An Apache-2.0 licence statement.

Compatibility facades and type-only packages still show a real import. They also name the package
most applications should install, so the example does not imply direct use.

Provider packages retain their transaction example and resource-ownership warning. The dashboard
server retains mounting, authentication, and deployment boundaries. These details determine correct
use and cannot fit in the shared minimum.

The core package needs more than the template because npm presents it as the TypeScript product
entrance. It adds schema installation, one enqueue-and-worker example, and links to worker deployment,
compatibility, CLI, and operational guidance.

### Core package README prototype

This draft was checked against `Queue.enqueue` in `typescript/core/src/queue.ts`, `EnqueueOptions`
in `typescript/core/src/types.ts`, `Handler` and `HandlerContext` in
`typescript/core/src/worker.ts`, and the exports in `typescript/core/src/index.ts`.

````markdown
# `@stablemates/workhorse`

The TypeScript client, worker runtime, schema tools, and operator API for the Workhorse PostgreSQL
durable execution protocol.

> **Public beta:** Workhorse is usable for evaluation and early production adoption, but 0.x minor
> releases may break compatibility, including the schema. There is no upgrade path between 0.x
> releases; ordered migrations begin at 1.0.0.

## Install

```bash
npm install @stablemates/workhorse
npx --package @stablemates/workhorse@0.1.0-beta.1 workhorse schema install
```

Install the schema during deployment. Runtime processes should verify compatibility rather than
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

## Next

- Follow the full [quickstart](https://workhorse.run/docs/quickstart).
- Run [dedicated worker processes](https://workhorse.run/docs/worker-processes).
- Read the [API reference](https://workhorse.run/docs/api) and
  [compatibility policy](https://workhorse.run/docs/compatibility).
- Report problems in [GitHub issues](https://github.com/stablemates/workhorse/issues).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
````

The example is intentionally smaller than the current root example. It proves the package's basic
shape without teaching schedules, retention, batching, or every durable handler primitive at once.

### Licence files

Each of the eight published npm package directories gets its own `LICENSE` and `NOTICE`. Package
archives must contain both files, and their contents must match the repository copies.

The package manifest's licence identifier is metadata, not the licence text. Keeping the files beside
each manifest also makes local packing and registry inspection unambiguous.

## Consequences

Readers can identify the product and reach a successful example before choosing deeper material.
Package registry pages become useful on their own, while the website remains the canonical tutorial
surface.

The same beta notice and legal files appear in several artifacts. A release check owns the canonical
notice text and asserts it verbatim across the root and package READMEs. The check also requires the
legal files and compares them with the repository originals.

README examples remain source-checked documentation. Changes to `Queue`, `Worker`, or provider
adapters must update their owning package README in the same work item.
