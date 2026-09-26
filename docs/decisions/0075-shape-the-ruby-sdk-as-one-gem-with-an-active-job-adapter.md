# ADR 0075: Shape the Ruby SDK as one gem with an Active Job adapter

- **Status:** Proposed
- **Date:** 2026-09-23
- **Related:** [ADR 0018](0018-framework-neutral-dashboard-host.md),
  [ADR 0021](0021-no-framework-integration-packages.md),
  [ADR 0023](0023-language-sdks-and-http-boundaries.md),
  [ADR 0028](0028-flat-per-language-repository-layout.md),
  [ADR 0029](0029-embeddable-dashboard-backends.md),
  [ADR 0030](0030-distinguish-suspensions-gates-and-child-joins.md),
  [ADR 0056](0056-set-the-1-0-0-exit-criteria.md),
  [ADR 0058](0058-fix-the-current-line-and-gate-floors-on-upstream-end-of-life.md),
  [ADR 0070](0070-publish-the-verified-sqlalchemy-transaction-accessor.md),
  [ADR 0071](0071-give-every-worker-a-pool-and-a-dedicated-heartbeat-connection.md),
  [ADR 0072](0072-converge-the-worker-runtime-defaults.md),
  [ADR 0074](0074-shape-the-rust-sdk-as-one-python-shaped-crate.md)

## Context

ADR 0023 makes the SQL protocol the authority and every language SDK an orchestration layer. The
parent issue, SM-896, adds Ruby as the fifth SDK. No Ruby code exists in this repository yet, so
this record designs it before SM-898 through SM-905 implement it.

Four facts shape the design more than the SDK itself does.

- **A Ruby gem named `workhorse` already exists.** Sitrox publishes it on RubyGems. It has shipped
  79 versions since 2017, and v1.5.2 was released on 2026-08-04 under the MIT license. It defines
  the top-level `Workhorse` module and `ActiveJob::QueueAdapters::WorkhorseAdapter`, which Rails
  selects with the `:workhorse` symbol. It stores jobs in a table named `jobs`. The name, the
  module, and the adapter symbol are all taken.
- **Most Ruby job code is Active Job code.** A Rails application writes `perform_later` and
  chooses a backend with `config.active_job.queue_adapter`. A Ruby SDK that offers no adapter asks
  a Rails team to rewrite every job. An adapter alone cannot express most of what Workhorse adds,
  as the Active Job section below shows.
- **ADR 0056 gate 2 freezes the shape early.** After 0.5.0 the Ruby API must change only
  additively. So this record settles the public API now, not after the first release.
- **A Rails team compares throughput with Solid Queue and GoodJob.** Both run jobs on a thread pool
  inside forked processes. A Ruby worker that falls behind them on the same host gives a Rails team
  no reason to switch.

The Ruby SDK copies the Python and Rust surfaces, as ADR 0074 did for Rust. Each design choice
below either follows from that rule or names the Ruby constraint that forces a difference.

Every external fact below was checked on 2026-09-23 against RubyGems, the Rails source, and the
upstream release pages.

## Decision

### Gem name and namespace

The gem is `stablemates-workhorse`. Callers write `require "stablemates/workhorse"`, which is also
the path Bundler requires for a hyphenated gem name. The root namespace is `Stablemates::Workhorse`.
The Active Job adapter is `ActiveJob::QueueAdapters::StablematesWorkhorseAdapter`, selected with
`:stablemates_workhorse`.

The name matches the PyPI distribution `stablemates-workhorse` and the npm scope
`@stablemates/workhorse`. Every piece of it avoids the Sitrox gem. An application can therefore
load both gems at once, for example during a migration from one to the other.

- `Stablemates::Workhorse` never touches the top-level `Workhorse` constant.
- The adapter constant and symbol differ from `WorkhorseAdapter` and `:workhorse`.
- Workhorse stores tasks in the `workhorse` schema, so no table collides with `jobs`.

RubyGems returned 404 for `stablemates-workhorse`, `stablemates`, `stablemates_workhorse`,
`workhorse-sdk`, and `workhorse_sdk` on 2026-09-23. A 404 does not guarantee that a push
succeeds. A hidden organization reservation can still refuse one, and nothing reserves a name
until its first push.

The maintainer owns the gem and reserves the name. Neither is agent work, and SM-903 records both.

1. The maintainer reserves the name. One route pushes a `0.0.0` placeholder by hand, as the
   crates.io reservation did. The other creates a pending trusted publisher and pushes the first
   release within its 12-hour expiry. A pending publisher alone reserves nothing.
2. The maintainer adds the co-owners.
3. The maintainer registers the trusted publisher: this repository, `.github/workflows/release.yml`,
   and the `rubygems` environment.

### One gem

The repository publishes one gem, rooted at `ruby/` under ADR 0028. It contains the client, the
worker, `Admin`, the embedded dashboard backend, and the Active Job adapter. Python ships one
distribution and Rust ships one crate, and each extra gem would add a release lane and version skew.

The gem has three runtime dependencies.

- **`pg`, at least 1.6 and below 2.** Every statement runs through a `PG::Connection`.
- **`connection_pool`, at least 2.5 and below 4.** The worker takes a pool under ADR 0071, and
  `pg` ships none. Active Support already depends on `connection_pool`, so a Rails application
  gains no new gem.
- **`concurrent-ruby`, at least 1.3.1 and below 2.** The worker builds its thread pool, its
  cancellation token, and its wakeups from it, as the Concurrency section describes. Active Support
  requires the same range, and Solid Queue and GoodJob build on it. So a Rails application again
  gains no new gem.

Everything else loads only when the caller has it.

- **Active Job.** The gemspec does not name `activejob`. The adapter loads through
  `ActiveSupport.on_load(:active_job)` when Active Support is present, or through
  `require "stablemates/workhorse/active_job"`. At load it refuses an Active Job older than the
  floor below.
- **OpenTelemetry.** The telemetry module activates when `opentelemetry-api` is loaded. Without it,
  the gem adds no OpenTelemetry dependency.
- **Rack.** The dashboard host implements the Rack calling convention directly. It needs no `rack`
  gem at runtime.

This is still one gem, as ADR 0021 requires. The adapter is an enqueue and execution boundary,
which ADR 0021 permits. It is not a web-framework integration. The gem ships no Railtie, no
generator, and no Rake task. A Rails application starts its worker with a short script that the
guide shows, as a Python application does.

### SQL comes from the generated catalogue

SM-898 adds `ruby/lib/stablemates/workhorse/sql_catalogue_generated.rb` to
`scripts/generate-sql-catalogues.ts` and to `pnpm sql-catalogues:check`. No Ruby module writes
protocol SQL by hand. The dashboard backend delegates to `Admin` and `Queue`, as Rust's does. So
Ruby adds nothing to the governed SQL surface.

### Ruby and Rails floors

The gem requires Ruby 3.3 or later and tests 3.3, 3.4, and 4.0. Ruby 3.2 reached end of life on
2026-04-01, and 3.3 is in security maintenance until its expected end on 2027-03-31. ADR 0058 then
raises the floor in a minor release, as it does for Python and Node.js.

The Active Job adapter requires Active Job 8.0 or later. Rails lists 8.0 security support until
2026-11-07 and 8.1 security support until 2027-10-10. It lists 7.2 security support until
2026-08-09, which has passed. The latest 7.2 release, 7.2.3.2, shipped on 2026-07-29.

- CI tests the adapter against 8.0 and 8.1.
- A non-blocking job tests it against Rails `main`, which is 8.2.0.alpha today.
- The floor rises to 8.1 in the first minor release after 8.0's security support ends.

The floor also removes version branches from the adapter. Rails 7.2 and later provide
`lease_connection`, `with_connection`, and `ActiveRecord.after_all_transactions_commit`. Rails 8.0
and later stopped asking the adapter whether to defer enqueue until commit.

SM-903 adds `ruby` and `activejob` entries to `support.json`, with their end-of-life dates, so the
ADR 0058 check covers them.

### Connection model

Every statement runs on a `PG::Connection`. The SDK never changes session state on a connection the
caller owns. It sets no type map and no `search_path`.

`Queue` and `Admin` take an executor, as Go and Rust do. An executor is one of these:

- a `PG::Connection`, used directly;
- a `ConnectionPool` of `PG::Connection`s, borrowed for one call;
- any object whose `with` method yields a `PG::Connection`.

The third form is the seam for Active Record.

```ruby
executor = Stablemates::Workhorse::ActiveRecordExecutor.new(ActiveRecord::Base)
```

`ActiveRecordExecutor#with` calls `with_connection` on the model class and yields that connection's
`raw_connection`. Inside a transaction, `with_connection` returns the connection that holds the
transaction. `raw_connection` materializes a lazy transaction before it returns the handle. So an
enqueue commits and rolls back with the caller's Active Record transaction.

That is the Ruby counterpart of ADR 0070's SQLAlchemy accessor, with the same obligation. SM-898
adds an integration test that proves an enqueue inside `ActiveRecord::Base.transaction` is invisible
before commit, visible after it, and absent after a rollback. The guide names the accessor only
after that test passes.

The caller owns the transaction. The queue never begins, commits, or rolls back. `Queue` caches its
compatibility check per executor, as Python's `Queue` does.

The worker takes a `ConnectionPool` and follows ADR 0071.

- Every worker on one pool shares one dedicated heartbeat connection. Ruby exposes object identity,
  so the sharing key is the pool object.
- The listener holds one connection from the pool for `wait_for_notify`.
- Each other statement borrows a connection for its own duration.
- A pool smaller than three connections is refused at construction. The error names the size
  found, the size needed, and `shared_heartbeats:`, which is the opt-out.

### Concurrency: a thread pool per process, and processes for CPU

The worker must match Solid Queue and GoodJob on the same host, or a Rails team has no reason to
switch. Both run jobs on a bounded thread pool, and both reach more CPU through forked processes.
The Ruby worker uses the same model and the same library.

The SDK is synchronous. It offers one API. Python needed an asynchronous twin because asyncio code
cannot call blocking code, and Ruby has no such split.

Inside one process, the worker builds on `concurrent-ruby`.

- **Handlers** run on a `Concurrent::ThreadPoolExecutor` that the worker owns. Its size is fixed
  at `concurrency`, from 1 through 100, and it never queues. The claim loop claims only as many
  tasks as the pool has idle threads.
- **The cancellation token** is a `Concurrent::Event`. Its reason is set once, atomically, before
  the event fires. So `wait` blocks without polling, and every reader sees the same reason.
- **The heartbeat and the listener** each run on a dedicated thread. Each thread waits on a
  `Concurrent::Event` with a timeout, so `stop` wakes it at once.
- **Shared state** uses `Concurrent::AtomicBoolean`, `Concurrent::AtomicFixnum`, and
  `Concurrent::Map` for the in-flight tasks. No worker state needs a hand-written lock.

Three rules keep the worker safe inside a caller's process.

- The worker never posts to `concurrent-ruby`'s global executors. Another library in the same
  process could fill them.
- The worker never calls `Thread#raise`, `Thread#kill`, or `Timeout.timeout`. Each can interrupt an
  `ensure` block. Cancellation is cooperative through the token, as in the other SDKs, and
  shutdown abandons a handler instead of killing it.
- When Rails is loaded, the worker wraps each native handler in `Rails.application.executor.wrap`.
  Code reloading and Active Record connection release then behave as they do in a request.

When Active Record is loaded and its pool is smaller than `concurrency`, the worker logs a warning at
`run`. Handlers would otherwise wait for Active Record connections that the pool cannot give.

`pg` releases the GVL during network waits, so handlers that wait on I/O run in parallel. Threads
still share the GVL for Ruby code. So CPU-bound work needs more processes, and the SDK supervises
them itself.

```ruby
Stablemates::Workhorse.run_worker_processes(processes: 4) do
  pool = ConnectionPool.new(size: 12) { PG.connect(ENV.fetch("DATABASE_URL")) }
  Stablemates::Workhorse::Worker.new(pool, concurrency: 10).handle("images.resize") { ... }
end
```

`run_worker_processes` forks after the caller has loaded the application, so each child shares the
loaded code. Each child calls the block and builds its own worker and pool. No connection crosses a
fork. The supervisor forwards `TERM` and `INT` to every child, and it waits up to `shutdown_grace`
for them to exit. It restarts a child that exits while the supervisor is not stopping. The capacity
is `processes` times `concurrency`, as in Solid Queue and GoodJob. On a platform without `fork`, the
call raises `NotImplementedError`.

`pg` has supported `Fiber.scheduler` fully since 1.3. So `Queue` and `Admin` calls also yield
correctly inside an `async` reactor, with no second API. The worker does not schedule fibers
itself. A handler may start a reactor inside its own thread.

#### The benchmark gate

SM-908 measures the Ruby worker against Solid Queue and GoodJob on one host. It runs each at the
same number of processes and threads. In the I/O-bound and CPU-bound scenarios, Workhorse must be at
least as fast as both. The no-op scenario is recorded and explained, because it measures only
per-task overhead. SM-908 must pass before SM-903 publishes the first release.

The harness lives in the maintainers' operations repository, beside the Node competitor baseline.
SM-907 refreshes that baseline first, so the Ruby numbers have a current reference.

### One error hierarchy

Every error the SDK raises descends from `Stablemates::Workhorse::Error < StandardError`. The
subclasses name a category and carry an `operation` attribute, as the variants of ADR 0074's
`Error` do. Callers rescue a category, not one class per primitive.

| Protocol outcome                    | Class                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| compatibility refusal               | `CompatibilityError` with `code`                                                          |
| `stale` on any durable call         | `LeaseLostError` with `task_id` and `operation`                                           |
| `conflict`                          | `ConflictError` with `operation` and `name`                                               |
| `limit_exceeded`                    | `LimitExceededError` with `operation` and `name`                                          |
| `already_waiting`                   | `AlreadyWaitingError` with `operation` and `name`                                         |
| `result_too_large`                  | `ChildResultLimitExceededError` with `result_bytes` and `limit_bytes`                     |
| `rate_limited` on progress          | `ProgressRateLimitedError` with `retry_after`                                             |
| SQLSTATE `P1001`, `P1003`, `P1005`  | `EnqueueIdempotencyConflictError`, `DependencyCycleError`, `DependencyLimitExceededError` |
| contract refusals                   | `ContractValidationError`, `ContractUnavailableError`, `ContractPolicyChangedError`       |
| external wait idempotency conflicts | `SignalIdempotencyConflictError`, `HumanWaitIdempotencyConflictError`                     |
| status the SDK does not know        | `UnexpectedStatusError` with `operation` and `status`                                     |
| cancellation observed by `check!`   | `CancelledError` with `reason`                                                            |
| shutdown grace elapsed              | `ShutdownIncompleteError` with `abandoned`                                                |
| any other `PG::Error`               | `DatabaseError`, with the original as `cause` and its `sqlstate`                          |

`code` is one of `:schema_not_installed`, `:schema_too_old`, `:schema_too_new`,
`:client_protocol_too_old`, and `:client_protocol_too_new`. An invalid argument raises Ruby's own
`ArgumentError` before any statement runs. An unknown status is always an error, never a silent
success.

`DatabaseError` keeps `PG::Error` out of the rescue clauses a caller writes. So a future `pg` major
does not move the governed surface, which ADR 0058 would otherwise count as a breaking change.

A handler fails its attempt by raising any `StandardError`. The worker maps it to the envelope in
`protocol/v1/failures.json`. The name is the exception's class name, and the stack is its
`backtrace` followed by each `cause`. SM-898 adds the `ruby` entry to `genericName` for an exception
whose class has no name. Redaction follows the claimed task's `redact_error_details`.

### Values and durations

Payloads, results, checkpoints, and progress are JSON values. The SDK decodes an object into a
`Hash` with `String` keys, so a Ruby handler reads the same keys a Go or Python producer wrote. It
refuses to encode a value that is not a JSON type. It never calls `to_s` on a `Time` or a `Symbol`
to make the value fit.

Ruby's `Integer` is unbounded, as Python's `int` is. A value beyond 2^53 - 1 therefore survives a
Ruby round trip and still rounds in a TypeScript or Go worker. `docs/parity.md` already documents
that limit.

A duration is a `Numeric` count of seconds, as `sleep` and Active Job's `wait:` use. The SDK calls
`to_f` on it, so an `ActiveSupport::Duration` also works. A point in time is a `Time`. Results are
`Data` value objects, which Ruby has had since 3.2.

### Worker surface

```ruby
module Stablemates::Workhorse
  class Worker
    def initialize(pool, queues: ["default"], worker_id: nil, concurrency: 1, lease: 30,
                   heartbeat: nil, poll_interval: nil, polling_only: false,
                   maintenance_interval: 1, maintenance_routine_interval: 60,
                   registry_interval: 5, disable_registry: false, schedule_namespaces: [],
                   schedule_catchup_limit: 100, shutdown_grace: 25, shared_heartbeats: false,
                   retry_delay: nil, on_registration_error: nil, logger: nil); end

    def handle(task_type, &handler) = self          # handler.call(payload, context) -> result
    def handle_batch(task_type, max_size:, linger:, &handler) = self
                                                     # handler.call(items, batch_context) -> results

    def run; end                                     # blocks until stop, then drains
    def run_once; end                                # -> true when a task ran
    def stop; end
    def pause; end
    def resume; end
    def paused?; end
    def worker_id; end
    def queues; end
  end

  def self.run_worker_process(worker); end
  def self.run_worker_processes(processes:, &build_worker); end   # build_worker.call -> Worker
end
```

The defaults are the ADR 0072 values in seconds. `heartbeat` defaults to a third of `lease`.
`poll_interval` defaults to 5 seconds with a listener, and to 0.25 seconds backing off to 5 seconds
without one. `retry_delay` is a callable over the attempt and the claimed task that returns seconds
or `nil`, as in Python.

Registration is by task type, and `handle` returns the worker so calls chain. Registering a task
type again replaces its handler. A task type with no handler is released so that another worker
can claim it. `handle_batch` validates its options as Python does: `max_size` lies between 1 and
100 and does not exceed `concurrency`.

Each round claims with `claim_many`, fair across the configured queues, as the Go and Rust workers
do. The heartbeat thread acts on each `heartbeat_v1` status as ADR 0074's table describes. The
cancellation reasons are `:requested`, `:deadline_exceeded`, `:execution_timeout`, `:lease_lost`,
`:suspended`, and `:shutdown`. A lease lost to `stale` cancels the token and records the loss, and
the fence token refuses every later write from that handler.

Shutdown follows the library model of ADR 0072, as Go and Rust do, because a `Worker` may run
inside the caller's process.

1. `stop` ends claiming.
2. In-flight handlers may finish within `shutdown_grace`.
3. At that deadline the worker cancels the remaining tokens with `:shutdown`.
4. It gives those handlers one bounded window to unwind.
5. It then stops renewing their leases, and `run` raises `ShutdownIncompleteError`.

`run_worker_process` owns the process. It traps `TERM` and `INT` to call `stop`. It exits after
`run` returns or raises, and a second signal exits at once, as Python's helper does.
`run_worker_processes` runs `run_worker_process` in each forked child. It accepts `processes` from 1
through 64. The Concurrency section describes its supervision.

```ruby
module Stablemates::Workhorse
  class CancellationToken
    def cancelled?; end
    def reason; end               # nil until cancelled
    def check!; end               # raises CancelledError once cancelled
    def wait(timeout = nil); end  # -> true once cancelled
  end
end
```

### Queue surface

```ruby
module Stablemates::Workhorse
  class Queue
    def initialize(executor, default_queue: "default"); end

    def enqueue(task_type, payload, queue: nil, priority: nil, concurrency_key: nil, budget: nil,
                run_at: nil, deadline: nil, execution_timeout: nil, max_attempts: nil,
                retry_policy: nil, tags: nil, idempotency: nil, debounce: nil, throttle: nil,
                dependencies: nil); end                    # -> EnqueueResult
    def enqueue_many(requests); end                        # -> Array<EnqueueResult>
    def cancel(task_id, requested_by:, reason: nil); end   # -> CancelResult
    def send_signal(task_id, name, payload, idempotency_key: nil); end
    def complete_human_wait(task_id, name, decision, actor:, idempotency_key: nil); end
    def health; end

    def sync_schedules(namespace, schedules, prune: true); end
    def sync_concurrency_policies(policies); end
    def sync_rate_limit_policies(policies); end
    def sync_budgets(budgets); end
    def sync_contracts(contracts); end

    def list_concurrency_policies(queues: nil); end
    def list_rate_limit_policies(queues: nil); end
    def list_budgets(names: nil); end
  end

  EnqueueResult = Data.define(:task_id, :outcome)
  # outcome is :accepted, :replayed, :replaced, :non_replaceable, or :coalesced
end
```

The keyword set mirrors Python's `EnqueueOptions` and Rust's struct. An `EnqueueRequest` carries
the same fields for `enqueue_many`. `enqueue` returns the task ID and the outcome together, as Rust
does, so Ruby has no `*_with_result` twin. Task inspection belongs to `Admin`.

The external-wait options mirror Python's. SM-898 takes their exact keyword names from Python's
`send_signal` and `complete_human_wait`. It changes nothing else in this block.

### Admin surface

`Admin` gives Ruby the same operator capability as the other four SDKs. It takes the same executor
as `Queue`, so a control can join a caller-owned transaction.

```ruby
module Stablemates::Workhorse
  AdminAudit = Data.define(:actor, :reason, :request_id)

  class Admin
    def initialize(executor); end

    def list_tasks(**query); end
    def get_task(task_id); end
    def get_task_timeline(task_id, **query); end

    def list_dead_letters(**query); end
    def redrive(source_task_id, audit:); end
    def redrive_many(audit:, **filter_and_options); end

    def get_checkpoint(task_id, name); end
    def list_checkpoints(task_id); end
    def get_progress(task_id); end
    def get_wait(task_id, name); end
    def list_waits(task_id); end
    def list_signal_waits(**query); end
    def list_human_waits(**query); end

    def list_workers; end
    def set_worker_paused(worker_id, paused, audit:); end
    def pause_queue(queue, audit:); end
    def resume_queue(queue, audit:); end
    def purge_queue(queue, audit:); end
  end
end
```

Every control takes an `AdminAudit`. `Admin` rejects a blank audit field before it calls
PostgreSQL, as Python does. The query keywords mirror Python's query fields, and each page carries
the cursor for the next page. `Admin` has no `health` method, because `Queue#health` reads the same
snapshot.

### Embedded dashboard backend

ADR 0029 requires every SDK to serve the dashboard from the host application's own HTTP server. Ruby
ships that backend before 1.0.0, as Rust does. SM-901 builds it after `Admin` lands.

```ruby
module Stablemates::Workhorse
  class Dashboard
    def initialize(executor, authorize:, path: "/workhorse", environment: "development",
                   audit_actor: nil, read_only: false, configured_workers: [],
                   allowed_hosts: []); end

    def call(env); end   # Rack: -> [status, headers, body]
  end
end
```

`Dashboard` is a Rack application, as Python's `DashboardHost` is a WSGI application. Rails mounts
it with `mount dashboard, at: "/workhorse"`, and Sinatra, Hanami, and `Rack::Builder` accept it
directly. The host reads its path from `SCRIPT_NAME` plus `PATH_INFO`, so a mounted instance and a
bare one agree. A request outside the mount path gets 404 with `X-Cascade: pass`, so the host's
own routes still answer it. So Ruby needs no framework integration gem, as ADR 0018 and ADR 0021
require.

The options mirror Python's. `authorize` receives the Rack `env` and returns a principal, `true`,
`false`, or a Rack response. Reads and controls go through `Admin` and `Queue`, so the backend writes
no dashboard SQL. The `dashboard/v1` procedure bindings are generated from
`dashboard/v1/procedures.json`. The gem ships the browser bundle, as the Python package does. The
Ruby cell becomes Supported only when the backend passes every shared `dashboard/v1` HTTP fixture.

### Durable handler context

```ruby
module Stablemates::Workhorse
  class HandlerContext
    def task; end            # ClaimedTask
    def cancellation; end    # CancellationToken

    def checkpoint(name, &block); end
    def sleep(name, seconds); end
    def sleep_until(name, time); end
    def wait_for_signal(name, timeout: nil); end
    def wait_for_human(name, context, timeout: nil); end

    def run_child(name, task_type, payload, **enqueue_options); end
    def run_children(children); end       # -> Hash{String => ChildOutcome}
    def run_children_all(children); end   # -> Hash{String => result}

    def get_progress; end
    def set_progress(progress); end
  end

  class BatchHandlerContext
    def tasks; end
    def cancellation; end
    def checkpoint(name, &block); end
    def get_progress; end
    def set_progress(progress); end
  end
end
```

Checkpoint replay runs the block only when no checkpoint of that name exists. Concurrent calls
that share one name share one in-flight request, as in Python and Rust. `run_children` keys its
outcomes by child name. `BatchHandlerContext` has no suspending or child primitives, as ADR 0030
requires.

### Suspension

A durable wait that returns `scheduled`, or a child join that returns `created`, suspends the
handler. ADR 0030 defines suspension as releasing the lease and restarting the handler from entry on
resume.

The Ruby worker copies Python's mechanism, backed by Go's flag. The context records a suspension
flag, cancels the token with `:suspended`, and raises a hidden `Suspension`. `Suspension` descends
from `Exception`, not `StandardError`, as Python's suspension descends from `BaseException`. So a
bare `rescue` or `rescue => e` in a handler does not catch it, and `ensure` blocks still run.

The worker checks the flag after the handler returns or raises. A handler that rescues `Exception`
and swallows the suspension still suspends, and the worker ignores its result. The worker then
submits `suspended_for_wait` or `suspended_for_child`.

`Suspension` carries `:nodoc:` and is not part of the governed surface. Handlers never construct it.

### Telemetry

The worker and queue log through a `Logger` the caller passes, or through a silent default. With
`opentelemetry-api` loaded, they emit spans with the shared names: `workhorse.claim`,
`workhorse.handler`, `workhorse.heartbeat`, `workhorse.retry`, `workhorse.complete`,
`workhorse.recovery`, and `workhorse.maintenance`. They record the shared counters and histograms
through the meter `workhorse`, and inject and extract W3C trace context. The attributes, outcome
values, and attribute limits match `python/src/workhorse/_telemetry.py`.

### Active Job

#### What the adapter contract offers

Rails talks to a backend through a small duck-typed adapter.

- **Required:** `enqueue(job)` and `enqueue_at(job, timestamp)`. The timestamp is a `Float` epoch.
- **Optional:** `enqueue_all(jobs)`. `perform_all_later` checks for it with `respond_to?`. It sets
  `successfully_enqueued` or `enqueue_error` on each job and returns the count enqueued.
- **Optional since Rails 8.1:** `stopping?`, which Active Job continuations poll. Rails `main`
  passes the job as an optional argument.
- **Execution:** the backend decodes the serialized hash and calls `ActiveJob::Base.execute`. Every
  backend in the ecosystem calls it, although Rails marks it `:nodoc:`. It raises
  `UnknownJobClassError` for a class the process cannot load.

Rails resolves `:stablemates_workhorse` by camelizing the symbol and looking up
`StablematesWorkhorseAdapter` in `ActiveJob::QueueAdapters`. It also accepts an adapter instance.
Rails deprecated its built-in Sidekiq adapter in 8.1 and removed it on `main`. The adapter now
ships in the Sidekiq gem. Solid Queue and GoodJob also ship their own. An adapter inside the
backend gem is therefore the Rails norm.

`job.serialize` produces the Ruby-only argument format. It encodes `GlobalID`, `Symbol`, `Time`,
`BigDecimal`, and `ActiveSupport::HashWithIndifferentAccess` under reserved `_aj_*` keys. No other
language can decode that format safely.

#### What Active Job cannot express

Active Job has no vocabulary for most of what Workhorse adds.

- **Idempotency, debounce, and throttle** decide whether an enqueue creates a task. `retry_job`
  re-enqueues the same `job_id`, so a key derived from the job would swallow Active Job's own retry.
- **Dependencies** name prerequisite task IDs. Active Job has no model of one job waiting on another.
- **Budgets, rate limits, deadlines, execution timeouts, and contracts** have no Active Job option.
- **Schedules** in Workhorse enqueue a task type with a JSON payload, not a serialized job.
- **Checkpoints, timers, signal waits, human waits, and child joins** suspend and restart the
  handler under ADR 0030. `perform` has no durable context to suspend.
- **Progress and batch delivery** need a context or a list of tasks that `perform` never receives.

#### How the established backends draw the line

Solid Queue 1.7.0 (released 2026-08-21) has no API outside Active Job. It adds class-level
extensions instead: `limits_concurrency`, recurring jobs in `config/recurring.yml`, and batches. It
records a failure and never retries it, so retries belong to Active Job.

GoodJob 4.19.3 (released 2026-09-21) does the same with concurrency rules, throttles, labels,
batches, and cron. Its unhandled-error retry is off by default.

Sidekiq 8.1.7 keeps a native API beside its adapter. Its wiki warns that Active Job adds about 30
percent overhead and that some Pro and Enterprise features break under it. Batches combined with
Active Job retries are one example. Sidekiq retries an Active Job failure that Active Job itself did
not handle, as it retries a native job.

Workhorse is closer to Sidekiq than to Solid Queue. It has a language-neutral native protocol that
four other SDKs already speak, and most of its features need a handler context.

#### Recommendation: native API plus one adapter with two job formats

Ruby ships the full native SDK above. It also ships one Active Job adapter, so a Rails application
can run every job on Workhorse: its own jobs, mail, Active Storage, and Turbo. One worker process
runs Active Job jobs and native handlers from the same queues.

Each Active Job class picks one of two formats.

|                  | Default job                                    | Typed job                                        |
| ---------------- | ---------------------------------------------- | ------------------------------------------------ |
| Declared by      | nothing                                        | `workhorse_options task_type: "images.classify"` |
| Task type        | `active_job`                                   | the declared task type                           |
| Payload          | `job.serialize`, with any Active Job arguments | the job's single argument, a JSON `Hash`         |
| Runs in          | the Ruby worker only                           | any worker registered for the task type          |
| Enqueued by      | `perform_later`                                | `perform_later`, or `Queue#enqueue` in any SDK   |
| Retries owned by | Active Job's `retry_on`                        | the Workhorse retry policy                       |

A default job needs no change. A typed job is portable, because its task type and payload are the
contract that every SDK already speaks. The Ruby class is only one handler for that contract.

```ruby
class ClassifyImageJob < ApplicationJob
  queue_as :ml
  workhorse_options task_type: "images.classify", max_attempts: 5

  def perform(payload)
    Classifier.run(payload["blob_id"], model: payload["model"])
  end
end

ClassifyImageJob.perform_later({ "blob_id" => 42, "model" => "v3" })
```

Work then moves between languages without a change at any call site.

- **Ruby to another language.** A Python worker registers `images.classify`, and the Ruby worker
  stops registering `ClassifyImageJob`. Every `perform_later` call stays as it is.
- **Another language to Ruby.** A Go service enqueues `images.classify` into the `ml` queue, and
  the Ruby worker runs `ClassifyImageJob#perform`.

Durable execution stays native-only for both formats. Checkpoints, timers, waits, child joins,
progress, and batch delivery need a handler context, and `perform` never receives one. Full Active
Job coverage is rejected below, and so are an adapter-only SDK and an enqueue-only adapter.

#### Adapter mapping

| Active Job                            | Workhorse                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `perform_later`, default job          | `enqueue` of task type `active_job` with `job.serialize` as the payload                                    |
| `perform_later`, typed job            | `enqueue` of the declared task type with the job's single `Hash` argument as the payload                   |
| `set(wait:)`, `set(wait_until:)`      | `enqueue_at` sets `run_at` from the `Float` epoch                                                          |
| `perform_all_later`                   | `enqueue_all` runs `enqueue_many` in atomic chunks of at most 1,000 jobs, of either format                 |
| `queue_as`                            | `queue`                                                                                                    |
| `queue_with_priority`, `priority`     | `priority`, passed through unchanged from 0 through 100. Otherwise it raises `ActiveJob::EnqueueError`     |
| `provider_job_id`                     | the Workhorse task ID, set at enqueue and at execution                                                     |
| `job_id` and job class                | the tags `active_job_id:<job_id>` and `active_job:<class>`. The class tag is omitted beyond 100 characters |
| `executions`, typed job               | the Workhorse attempt number minus one before `perform` runs                                               |
| `retry_on`, default job               | stays in Active Job. `retry_job` enqueues a new task, and the current task completes                       |
| `retry_on`, typed job                 | refused. `retry_job` raises `ArgumentError`, which fails the attempt                                       |
| `discard_on`, `after_discard`         | stay in Active Job. The task completes                                                                     |
| an exception Active Job re-raises     | fails the attempt under the Workhorse retry policy                                                         |
| `stopping?`                           | true once the worker's `stop` has begun                                                                    |
| continuations (`step`, `checkpoint!`) | stay in Active Job. An interrupted default job resumes through `retry_job` as a new task                   |

Workhorse runs higher priorities first. Solid Queue runs lower numbers first. The adapter does not
invert the number, so the dashboard and every SDK show the value the job set. The guide states the
direction.

A typed job's payload must be one `Hash` with `String` keys and JSON values. The adapter refuses
any other argument list with `ArgumentError` before any statement runs, as the Values section
requires. So `perform` receives exactly the `Hash` that the caller enqueued.

Default jobs share one task type, so a worker runs every default job class without listing them.
Typed jobs are listed explicitly, because Workhorse releases a task type with no handler. An
unregistered typed job would wait forever, and Rails does not load job classes eagerly in
development.

```ruby
worker = Stablemates::Workhorse::Worker.new(pool, queues: %w[default mailers ml], concurrency: 5)
Stablemates::Workhorse::ActiveJob.handle(worker, jobs: [ClassifyImageJob])
worker.handle("invoice.charge") { |payload, _context| Billing.charge(payload["invoice_id"]) }
Stablemates::Workhorse.run_worker_process(worker)
```

`ActiveJob.handle` registers `active_job` and the task type of each listed class. It raises
`ArgumentError` for a listed class without a task type, and for two classes that declare one task
type. `jobs:` defaults to an empty list.

For a default job, the handler sets `provider_job_id` and calls `ActiveJob::Base.execute`. For a
typed job, it builds the job from the payload directly. So Active Job's argument decoder never reads
a payload that another language wrote, and a reserved `_aj_*` key in that payload stays a plain
key. The handler sets `job_id` from the `active_job_id:` tag, or from the task ID when another SDK
enqueued the task. It then runs the same execute callbacks and `perform_now` that `execute` runs.
The Active Job Railtie wraps each execution in the Rails executor, so code reloading and connection
release behave as in any other backend.

#### Retries and crash recovery

A default job leaves the retries it declares to Active Job. A `retry_on` match calls `retry_job`,
which enqueues a new task with the same `job_id` and an incremented `executions`. The current task
then completes. So the adapter never deduplicates on `job_id`.

A typed job leaves every retry to Workhorse. Its retries belong to the task type, so they behave
the same whichever language runs it. `retry_job` would create a second task that a Python or Go
worker never creates. So a `retry_job` call during a typed execution raises `ArgumentError` naming
the class, and the attempt fails under the Workhorse policy. `discard_on` still works, because it
only completes the task. A later additive option may map `retry_on`'s wait onto the worker's
per-attempt retry delay.

Workhorse owns everything Active Job does not handle. An exception that escapes `perform` fails the
attempt, and PostgreSQL applies the task's `max_attempts` and retry policy. A worker that dies
mid-job loses its lease, and recovery runs the job again. Sidekiq has the same division.

The adapter enqueues with the Workhorse default of 25 attempts. One consequence needs the guide's
attention. When `retry_on` exhausts its attempts without a block, Active Job re-raises. The task
then retries under the Workhorse policy until its own attempts run out.

A default job that wants Active Job to own every retry sets `max_attempts: 1`. A crash then
dead-letters the job instead of rerunning it. An operator can still redrive it from the dashboard.
That matches Solid Queue's default, and the guide presents both choices.

#### Transactional enqueue

The adapter enqueues through an `ActiveRecordExecutor` over `ActiveRecord::Base` by default. So a
`perform_later` inside a transaction commits and rolls back with it.

Rails can defer the enqueue until after commit instead. The adapter cannot influence that choice,
because Rails 8.0 and later ignore the adapter's opinion. Rails' default is no deferral through
8.1. `load_defaults "8.2"` turns deferral on. A job that must commit atomically with its caller's
rows sets `self.enqueue_after_transaction_commit = false`. The guide names that setting.

#### Adapter extensions

A job class may declare four static options.

```ruby
class ReportJob < ApplicationJob
  include Stablemates::Workhorse::ActiveJob::Options

  workhorse_options max_attempts: 5,
                    tags: %w[reports],
                    concurrency_key: ->(job) { "account:#{job.arguments.first.id}" }
end
```

- `task_type` makes the class a typed job, as the recommendation above describes. A string that
  names no valid task type raises `ArgumentError`, and so does `active_job`.
- `max_attempts` sets the task's attempt budget, as the retry section above describes.
- `tags` adds at most 18 tags beside the adapter's two.
- `concurrency_key` is a string or a lambda over the job. A concurrency policy synchronized through
  `Queue#sync_concurrency_policies` bounds it, as it bounds a native task.

These options annotate a task without changing whether Active Job's enqueue creates one. Solid
Queue's `limits_concurrency` and GoodJob's concurrency rules show that Rails teams expect
concurrency control. Any other key raises `ArgumentError` when the class loads. A new option later
is an additive change under gate 2.

Idempotency, debounce, and throttle are the likeliest additions for typed jobs. A typed job never
creates a second task on retry, so a key derived from it cannot swallow a retry. A default job can
never take them, because `retry_job` re-enqueues the same `job_id`.

`set` passes only `wait`, `wait_until`, `queue`, and `priority` to the adapter, as Rails defines it.
The adapter reads nothing else from it.

#### Native-only parity cells

`docs/parity.md` gains a Ruby column whose cells describe the native SDK. SM-899 adds a short list
below the worker table. It names the Client and Worker rows that an Active Job job cannot reach.
The table below is the source of that list.

| Row                                          | Default job | Typed job    |
| -------------------------------------------- | ----------- | ------------ |
| Transactional enqueue in a caller-owned tx   | Supported   | Supported    |
| Atomic batch enqueue                         | Supported   | Supported    |
| Delayed enqueue (`runAt` / `run_at`)         | Supported   | Supported    |
| Priority                                     | Supported   | Supported    |
| Tags and max attempts                        | Supported   | Supported    |
| Concurrency keys                             | Supported   | Supported    |
| Enqueue trace-context propagation            | Supported   | Supported    |
| Claiming and handler execution               | Supported   | Supported    |
| Bounded worker concurrency                   | Supported   | Supported    |
| Heartbeats, lease recovery, fenced ownership | Supported   | Supported    |
| Graceful stop and signal drain               | Supported   | Supported    |
| Payload and result contracts                 | Native only | Payload only |
| Persisted retry policies                     | Native only | Native only  |
| Absolute deadlines and execution timeouts    | Native only | Native only  |
| Enqueue idempotency                          | Native only | Native only  |
| Keyed debounce                               | Native only | Native only  |
| Keyed throttle                               | Native only | Native only  |
| Task dependencies with terminal policies     | Native only | Native only  |
| Recurring schedule definition sync           | Native only | Native only  |
| Cooperative cancellation delivery            | Native only | Native only  |
| Durable checkpoints (handler context)        | Native only | Native only  |
| Durable timers (`sleep` / `sleepUntil`)      | Native only | Native only  |
| Signal and human-decision waits              | Native only | Native only  |
| Linked child fan-out and result join         | Native only | Native only  |
| Latest-value progress reporting              | Native only | Native only  |
| Batch handler delivery                       | Native only | Native only  |

A typed job's payload passes the contract that `Queue#sync_contracts` registered for its task type,
because the adapter enqueues through `Queue`. The adapter stores no result for either format, so
result contracts stay native-only.

The policy, budget, and schedule management rows are configuration calls on `Queue`, not per-job
options, so an Active Job application calls them natively. Cancellation requests reach an Active
Job task through `Queue#cancel` with its `provider_job_id`. A running job cannot observe the request,
because `perform` receives no token. The row therefore reads Native only. Active Job continuations
observe only worker shutdown, and a cancelled job must not resume itself.

Recurring Active Job jobs are the most likely later extension, because Solid Queue and GoodJob
both offer them. They would add a schedule whose payload is a serialized job. That is additive, so
this record defers it past 0.5.0.

### Governed surface and release

SM-904 records the public surface in `api/ruby.txt`. It covers every public constant, method
signature, keyword, and `Data` member under `Stablemates::Workhorse`, plus the adapter constant.
Constants marked `:nodoc:` stay out. The first release is 0.5.0. Gate 2 then needs six weeks and two
published minors, 0.5 and 0.6, without a non-additive change before 1.0.0.

SM-903 adds a `rubygems` job to `.github/workflows/release.yml` on the Rust crate's pattern.

- It builds from `ruby/` with `rubygems/release-gem`, which accepts a `working-directory` and
  writes attestations.
- It compares the gemspec version with the release tag. On a mismatch it writes a notice and skips
  publishing, as the crates.io job does.
- It authenticates through trusted publishing in the `rubygems` environment, with
  `id-token: write`.

`docs/compatibility.md` gains a Ruby gem section that mirrors the Rust crate section.

### Scope and line budget

The budget is 4,500 to 6,500 lines in `ruby/lib/`, excluding the generated catalogue, the
dashboard module, and tests. Ruby needs no type declarations and no asynchronous twin, so it lands
below Python's 8,242. The Active Job adapter takes about 600 of those lines. The dashboard module
adds about 1,000 lines outside the budget.

| Path under `ruby/lib/stablemates/workhorse/`                   | Owner  | Contents                                     |
| -------------------------------------------------------------- | ------ | -------------------------------------------- |
| `../workhorse.rb`, `errors.rb`, `types.rb`, `compatibility.rb` | SM-898 | entry point, errors, value objects           |
| `executor.rb`, `active_record_executor.rb`                     | SM-898 | executor forms and the verified accessor     |
| `queue.rb`, `contracts.rb`, `policies.rb`                      | SM-898 | `Queue` and synchronization                  |
| `sql_catalogue_generated.rb`                                   | SM-898 | generated, outside the budget                |
| `worker.rb`, `worker/{heartbeat,listener,batch,process}.rb`    | SM-900 | run loop, leases, listener, batches, signals |
| `worker/supervisor.rb`                                         | SM-900 | `run_worker_processes` and its children      |
| `context.rb`, `waits.rb`, `children.rb`                        | SM-900 | durable context and suspension               |
| `telemetry.rb`                                                 | SM-900 | spans, metrics, and trace context            |
| `admin.rb`                                                     | SM-901 | the operator client and its page types       |
| `dashboard.rb`, `dashboard/`                                   | SM-901 | the Rack backend, outside the budget         |
| `active_job.rb`, `active_job/`                                 | SM-902 | adapter, both job formats, and options       |

SM-899 runs the shared SQL and runtime fixtures from Ruby and adds the Ruby parity column. Each cell
flips only with executed evidence, as Rust's cells do. SM-905 writes the Ruby documentation and the
Active Job guide. SM-908 runs the benchmark gate.

## Consequences

### Positive

- A Rails application moves every job to Workhorse without rewriting it, framework jobs included.
  It then runs one queue, one worker process, and one dashboard.
- A typed job moves to another language, or receives work from one, without a change at any call
  site. No other Active Job backend offers that.
- A job that needs a durable feature moves to the native API, and the same worker runs it.
- The worker uses the thread pool and process model that Solid Queue and GoodJob use. The SM-908
  gate holds it to their throughput before the first release.
- The gem loads beside Sitrox's `workhorse`, so no name, constant, symbol, or table collides.
- Callers learn one gem, one namespace, and one synchronous API.
- The Python and Rust documentation transfers to Ruby with renamed identifiers.
- A swallowed suspension still suspends, because it bypasses `rescue => e` and the worker checks a
  flag.

### Negative

- Active Job users reach fewer than half of the Client and Worker rows without leaving Active Job.
  The guide has to explain the boundary clearly.
- A job that exhausts `retry_on` without a block retries again under the Workhorse policy unless it
  sets `max_attempts`.
- The gem keeps worker-side Active Job execution. It depends on the `:nodoc:` `execute` API,
  `stopping?`, and a test matrix of Rails 8.0, 8.1, and `main`.
- A typed job gives up `retry_on`. A Rails developer has to learn that its retries follow the task
  type.
- CPU-bound work needs `processes:` above 1, because threads share the GVL. Solid Queue and GoodJob
  ask the same of their users.
- The first release waits for SM-908. If Ruby falls short there, the release waits for the fix.
- The Active Job floor follows Rails' short support windows. It rises to 8.1 within weeks of the
  first release.
- `ActiveJob::Base.execute` is `:nodoc:` in Rails. A Rails release could change it, and only the
  CI job against `main` warns early.
- The priority direction differs from Solid Queue's, which can surprise a team that migrates.

## Rejected alternatives

- **The gem name `workhorse` or the `Workhorse` namespace.** Sitrox owns the name and the constant.
  Colliding would break any application that loads both gems.
- **A shorter gem such as `stablemates`.** It claims an organization-wide name for one product and
  breaks the correspondence with PyPI and npm.
- **Separate gems for Active Job, Rails, the dashboard, or OpenTelemetry.** Each doubles a release
  lane for a few hundred lines. Optional loading already keeps them out of a caller that does not
  use them.
- **A Railtie.** It would register the adapter and a Rake task automatically. ADR 0021 rejects
  framework integration packages, and `ActiveSupport.on_load` reaches the same result without one.
- **Active Record's connection as the only driver.** It would tie the worker to Rails and to Active
  Record's pool sizing. A non-Rails service needs the SDK too.
- **A fiber-based worker.** Handler code in a Rails application assumes threads, and `pg` already
  lets a handler use fibers inside its own thread.
- **An asynchronous twin of every client.** Ruby has no colored functions, so a second API would
  double the surface for no caller.
- **Full Active Job coverage.** Idempotency and debounce would swallow a default job's `retry_job`. A durable wait
  cannot suspend a `perform` method. Sidekiq's experience shows that advanced features break when
  forced through Active Job.
- **An adapter-only SDK.** It would make Ruby the only language without durable handlers, and it
  would give up cross-language work.
- **A task type for every job class.** Every class, framework jobs included, would need
  registration before a worker could run it, and an unregistered class would wait forever. Typed
  jobs keep that cost to the classes that opt in for portability.
- **An enqueue-only adapter.** It would drop worker-side execution and send `perform_later` to a
  second backend. The application would then run two queues, and Workhorse could not replace Solid
  Queue.
- **A separate adapter for portable jobs.** Two adapters would split one application's jobs across
  two configurations. One adapter lets each class choose its format.
- **A hand-written thread pool on `Thread` and `Thread::Queue`.** Every Rails application already
  loads `concurrent-ruby`, and the competing backends rely on it. A hand-written pool would solve
  again what that library already solves.
- **`max_attempts: 1` as the adapter default.** A worker crash would dead-letter every job in
  flight. Crash recovery is the reason to choose a leased queue.
- **Inverting Active Job priority.** Each SDK and the dashboard would show a number other than the
  one the job set.
- **Supporting Rails 7.2.** Its security support ended on 2026-08-09 according to the Rails
  maintenance page. Supporting it would also require a second transaction-deferral path.
- **Leaving the Rack dashboard until after 1.0.0.** Ruby would be the only SDK that cannot host the
  operator console, which ADR 0029 promises in every language.
