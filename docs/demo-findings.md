# What does the demo prove?

The demo proves that a normal TypeScript application can enqueue and inspect jobs which TypeScript,
Python, and Go workers execute through their public SDKs. It is a product example, not the
compatibility or performance test suite.

## Application boundary

The Hono process and three language worker processes share only PostgreSQL. The web process uses
Drizzle for an application-owned transaction that inserts an order and enqueues its job atomically.
Each worker owns its own database client and registers itself in `workhorse.worker_registry`, so the
dashboard discovers the fleet without process-local controller objects.

Each runtime owns a queue for its application handlers. TypeScript, Python, and Go also compete for
one runtime-neutral job on `demo-shared`, which exercises compatible claim and settlement through
every public SDK. The TypeScript worker separately serves the rate-limited `partner-api` queue.

The application mounts the publishable dashboard host. Development supplies the dashboard's Vite
middleware, while production serves the built browser bundle through the same host. Passing
`{ dashboard: false }` removes the browser and RPC routes without changing queue behavior.

## Lifecycle evidence

The startup seed creates a task-visible showcase with one-off jobs and recurring definitions.
[`demo-feature-coverage.md`](demo-feature-coverage.md) owns the family and scenario map.

The examples preserve retry policy, checkpoint output, wait provenance, progress, cancellation,
terminal outcomes, and redrive lineage in PostgreSQL. The task drawer reads those records through
the dashboard server's versioned read surface.

The demo also exercises queue pause, purge, worker pause, recurring schedules, retention,
maintenance, health, and a rate-limited `partner-api` queue. That queue leaves an admissible backlog
visible while PostgreSQL refills its queue-wide and per-key rate tokens.

## What belongs to verification instead

The demo shows behavior at human speed. It does not establish throughput, race safety, package
contents, or upgrade compatibility. Integration tests own transactional behavior and lifecycle
invariants. Packed-package tests own consumer exports and installed assets. Benchmarks own claim
cost, contention, and throughput. Migration tests own schema equivalence.

The demo also does not replace deployment authentication. Its local dashboard uses an explicit
development authorization boundary. The standalone dashboard tests and deployment guidance own the
built-in administrator login, TLS origin, session, rotation, and throttle contracts.

## Known coverage gaps

The current showcase does not represent every public feature. The coverage map owns the exact
omissions and distinguishes task-visible examples from operational surfaces. WOR-109 tracks the
missing families and actions.
