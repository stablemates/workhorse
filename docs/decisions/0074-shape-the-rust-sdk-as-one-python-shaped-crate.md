# ADR 0074: Shape the Rust SDK as one Python-shaped crate

- **Status:** Accepted
- **Date:** 2026-09-22
- **Related:** [ADR 0023](0023-language-sdks-and-http-boundaries.md),
  [ADR 0028](0028-flat-per-language-repository-layout.md),
  [ADR 0030](0030-distinguish-suspensions-gates-and-child-joins.md),
  [ADR 0071](0071-give-every-worker-a-pool-and-a-dedicated-heartbeat-connection.md),
  [ADR 0072](0072-converge-the-worker-runtime-defaults.md)

## Context

ADR 0023 makes the SQL protocol the authority and every language SDK an orchestration layer. ADR
0028 gave Rust the `rust/` directory. The Rust code that grew there never received a design.

The workspace holds two crates that disagree with each other.

- `rust/` publishes `workhorse-client`. Its `Queue` passes `enqueue_v1` arguments in the wrong
  positions, serializes batches in snake case, and issues bare `BEGIN` and `COMMIT` on a borrowed
  client.
- `rust/workhorse-worker/` defines its own `Client` trait and a separate worker loop. It has no
  license or description, so the release lane cannot package it.
- `rust/src/durable_context/` models checkpoints, waits, and children in memory behind a
  `SettlementSink`. `rust/src/durable_postgres.rs` calls the real protocol functions beside it.
  Two durable models exist, and neither one is wired to a worker.
- `rust/README.md` describes a `rust/workhorse/` crate that does not exist.

The parent issue, SM-16, asks for a Rust SDK of four to six thousand lines with a Python-shaped
API. Python and Go already carry the whole product surface. Python's `src/workhorse` is 8,242
lines without the dashboard module. Go is 7,919 lines without its generated catalogue, and about
7,100 without its admin surface. Both include a synchronous or operator surface that Rust does not
need, so the budget is reachable if Rust copies their behavior instead of inventing its own.

This record fixes the crate layout, the public API, and the division of the implementation issues
SM-877 through SM-882. It does not implement the SDK.

## Decision

### One published crate

The workspace publishes one crate, rooted at `rust/`. Its library name is `workhorse`, so callers
write `use workhorse::…`. The worker lives in `rust/src/worker/`. SM-878 deletes
`rust/workhorse-worker/` and removes it from the workspace members.

The crate has no `worker` feature. Python ships one `workhorse` package and Go ships one module,
and each feature combination would need its own test lane. The single optional feature is
`opentelemetry`, described below.

The release lane packages exactly that one crate. SM-880 points `scripts/check-rust-release.ts` at
it and keeps the path-dependency consumer that asserts `CLIENT_PROTOCOL_VERSION`.

The crates.io package name is a maintainer decision, recorded on SM-882. The name `workhorse` was
unclaimed on 2026-09-22 and is the recommendation. If it is taken first, the fallback is
`stablemates-workhorse`, which matches the PyPI distribution. Either way, `[lib] name =
"workhorse"` keeps the import path stable. Crate ownership, token storage, and the publishing
procedure are also maintainer decisions.

### SQL comes from the generated catalogue

`scripts/generate-sql-catalogues.ts` already emits the TypeScript, Python, and Go catalogues from
`protocol/v1/manifest.json`. SM-877 adds `rust/src/sql_catalogue_generated.rs` to that generator
and to `pnpm sql-catalogues:check`. No Rust module writes protocol SQL by hand. This removes the
argument-position defect class that the current `Queue` shows.

### Connection model

The worker takes a `deadpool_postgres::Pool`, and the crate re-exports `deadpool_postgres`. The
pool follows ADR 0071.

- Every worker on one pool shares one dedicated heartbeat connection. deadpool exposes no pool
  identity, so SM-878 chooses the sharing key.
- The listener holds one pooled connection. Each statement borrows a pooled connection for its own
  duration.
- A pool smaller than three connections is refused at construction. The error names the size
  found, the size needed, and `shared_heartbeats`, which is the opt-out.

`Queue` takes an executor, as Go's `NewQueue` does. The crate defines a sealed `Executor` trait
with explicit implementations for `tokio_postgres::Client`, `tokio_postgres::Transaction<'_>`,
`deadpool_postgres::Pool`, `deadpool_postgres::Object`, and references to each. A blanket
implementation over `GenericClient` is rejected because coherence would then forbid the `Pool`
implementation.

The caller owns the transaction. Transactional enqueue passes the open transaction as the
executor, and the queue never begins, commits, or rolls back. Python and Go document the same seam
in `docs/guides/200-transactional-enqueue.md`, and it matches the caller-owned shape of SM-874.
Each `Queue` caches its compatibility check, as Python's `AsyncQueue` does.

### One structured error type

The crate exposes one `#[non_exhaustive] pub enum Error`, derived with `thiserror`. Variants name a
category and carry an `Operation` field, instead of one type per primitive. Go wraps every
per-primitive lease error so that it unwraps to `ErrLeaseLost`, which shows that callers branch on
the category.

| Protocol outcome                    | Variant                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------- |
| compatibility refusal               | `Compatibility { code: CompatibilityCode }`                                |
| `stale` on any durable call         | `LeaseLost { task_id, operation }`                                         |
| `conflict`                          | `Conflict { operation, name }`                                             |
| `limit_exceeded`                    | `LimitExceeded { operation, name }`                                        |
| `already_waiting`                   | `AlreadyWaiting { operation, name }`                                       |
| `result_too_large`                  | `ChildResultLimitExceeded { result_bytes, limit_bytes }`                   |
| `rate_limited` on progress          | `ProgressRateLimited { retry_after }`                                      |
| SQLSTATE `P1001`, `P1003`, `P1005`  | `EnqueueIdempotencyConflict`, `DependencyCycle`, `DependencyLimitExceeded` |
| contract refusals                   | `ContractValidation`, `ContractUnavailable`, `ContractPolicyChanged`       |
| external wait idempotency conflicts | `SignalIdempotencyConflict`, `HumanWaitIdempotencyConflict`                |
| status the SDK does not know        | `UnexpectedStatus { operation, status }`                                   |
| cancellation observed by `check()`  | `Cancelled(CancelReason)`                                                  |
| shutdown grace elapsed              | `ShutdownIncomplete { abandoned }`                                         |

`CompatibilityCode` has one variant per code: `SchemaNotInstalled`, `SchemaTooOld`,
`SchemaTooNew`, `ClientProtocolTooOld`, and `ClientProtocolTooNew`. `Postgres`, `Pool`, `Json`,
and `InvalidArgument` wrap their sources. `Error::Suspended` is hidden from documentation and is
described under suspension.

Every status that Python and Go turn into an error becomes a variant here. The variant follows the
protocol status, not the per-primitive class name. For example, Go names `already_waiting` from
`wait_for_signal` a `SignalWaitConflict`, and Rust returns `AlreadyWaiting`. An unknown status is
always an error, never a silent success.

Handlers return `Result<R, HandlerError>`. `HandlerError` converts from any `std::error::Error`,
the way `anyhow::Error` does, and does not itself implement `std::error::Error`. The worker maps it
to the failure envelope in `protocol/v1/failures.json`.

- The name comes from `HandlerError::named(name, err)`. Without a declared name the worker uses the
  generic name `Error`. SM-877 adds that `rust` entry to `genericName`.
- The worker never derives a name from `std::any::type_name`. Its output contains `:` and `<`, and
  the envelope forbids `<`.
- The stack is the source chain, followed by a `std::backtrace::Backtrace` when one was captured.
- A panic fails the attempt with the name `Panic`.
- Redaction follows the claimed task's `redact_error_details`, as in the other SDKs.

### Worker surface

```rust
pub struct Worker { /* private */ }

impl Worker {
    pub fn new(pool: deadpool_postgres::Pool, options: WorkerOptions) -> Result<Self, Error>;

    pub fn handle<P, R, F, Fut>(self, task_type: &str, handler: F) -> Self
    where
        P: serde::de::DeserializeOwned + Send + 'static,
        R: serde::Serialize + Send + 'static,
        F: Fn(P, HandlerContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, HandlerError>> + Send + 'static;

    pub fn handle_batch<P, R, F, Fut>(self, task_type: &str, options: BatchOptions, handler: F) -> Self
    where
        P: serde::de::DeserializeOwned + Send + 'static,
        R: serde::Serialize + Send + 'static,
        F: Fn(Vec<BatchItem<P>>, BatchHandlerContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Vec<BatchResult<R>>, HandlerError>> + Send + 'static;

    pub async fn run(&self) -> Result<(), Error>;
    pub async fn run_once(&self) -> Result<bool, Error>;
    pub fn stop(&self);
    pub fn pause(&self);
    pub fn resume(&self);
    pub fn is_paused(&self) -> bool;
    pub fn worker_id(&self) -> &str;
    pub fn queues(&self) -> &[String];
}

pub async fn run_worker_process(worker: Worker) -> Result<(), Error>;

pub struct BatchOptions { pub max_size: usize, pub linger: Duration }
```

Registration is by task type, and each call consumes and returns the worker. Python chains `handle`
the same way. Registering a task type again replaces its handler, as in Python. A task type with no
handler is released so that another worker can claim it. `handle_batch` validates its options as
Python does: `max_size` lies between 1 and 100 and does not exceed `concurrency`.

The payload decodes with `serde_json` into the handler's type. A decode failure fails the attempt
with the name `PayloadDecodeError`, under the task's normal retry policy. The handler's result
serializes to JSON and goes to `complete_v1`, which enforces `result_max_bytes`.

`run` claims until `stop` is called and returns after draining. Dropping the `run` future abandons
the owned tasks, and their leases expire. `run_once` claims one round and reports whether it ran a
task. `run_worker_process` wires `SIGTERM` and `SIGINT` to `stop`. A second signal exits the
process, as with Python's helper.

Concurrency is a Tokio semaphore between 1 and 100. Each round claims with `claim_many`, fair
across the configured queues, as Go's worker does. LISTEN/NOTIFY wakes the loop, and polling is the
fallback. A missing listener logs one warning, per ADR 0071.

Heartbeat rounds renew every owned task on the shared heartbeat connection. The worker acts on
each `heartbeat_v1` status.

| Status              | Worker action                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `accepted`          | Records the new lease expiry.                                                            |
| `cancel_requested`  | Cancels the handler token with `CancelReason::Requested`.                                |
| `deadline_exceeded` | Cancels the handler token with `CancelReason::DeadlineExceeded`.                         |
| `timeout_exceeded`  | Cancels the handler token with `CancelReason::ExecutionTimeout`.                         |
| `stale`             | Cancels with `CancelReason::LeaseLost`, aborts the handler task, and records lease loss. |

A local execution-timeout timer cancels the token too. If no renewal succeeds for one lease period,
the watchdog treats the lease as lost, as ADR 0071 describes. The fence token rides on every
mutation, so a write from an aborted handler is refused by PostgreSQL rather than applied.

`WorkerOptions` implements `Default` with the ADR 0072 values as `Duration`s.

```rust
#[non_exhaustive]
pub struct WorkerOptions {
    pub queues: Vec<String>,                   // ["default"]
    pub worker_id: Option<String>,             // generated
    pub concurrency: usize,                    // 1
    pub lease: Duration,                       // 30 s
    pub heartbeat: Option<Duration>,           // lease / 3
    pub poll_interval: Option<Duration>,       // 5 s with a listener, 250 ms backing off to 5 s without
    pub polling_only: bool,                    // false
    pub maintenance_interval: Duration,        // 1 s
    pub maintenance_routine_interval: Duration,// 60 s
    pub registry_interval: Duration,           // 5 s
    pub disable_registry: bool,                // false
    pub schedule_namespaces: Vec<String>,      // empty
    pub schedule_catchup_limit: u32,           // 100
    pub shutdown_grace: Duration,              // 25 s
    pub shared_heartbeats: bool,               // false
    pub retry_delay: Option<Arc<dyn Fn(u32, &ClaimedTask) -> Option<Duration> + Send + Sync>>,
    pub on_registration_error: Option<Arc<dyn Fn(&Error) + Send + Sync>>,
}
```

Shutdown follows the Go library model from ADR 0072, because a Rust `Worker` also runs inside the
caller's process. `stop` ends claiming, and in-flight handlers may finish within `shutdown_grace`.
At that deadline the worker cancels the remaining tokens with `CancelReason::Shutdown` and gives
those handlers one bounded window to unwind. It then stops renewing their leases, and `run` returns
`Err(Error::ShutdownIncomplete { abandoned })`. The caller decides whether to exit.
`run_worker_process` owns the process, so it exits after that return, as Python's helper does.

```rust
#[derive(Clone)]
pub struct CancellationToken { /* tokio_util::sync::CancellationToken plus a cause */ }

impl CancellationToken {
    pub fn is_cancelled(&self) -> bool;
    pub async fn cancelled(&self);
    pub fn reason(&self) -> Option<CancelReason>;
    pub fn check(&self) -> Result<(), Error>; // Err(Error::Cancelled(reason)) once cancelled
}

#[non_exhaustive]
pub enum CancelReason { Requested, DeadlineExceeded, ExecutionTimeout, LeaseLost, Suspended, Shutdown }
```

### Queue surface

```rust
pub struct Queue<E: Executor> { /* private */ }

impl<E: Executor> Queue<E> {
    pub fn new(executor: E, default_queue: &str) -> Self;

    pub async fn enqueue<P: Serialize>(&self, task_type: &str, payload: &P, options: EnqueueOptions)
        -> Result<EnqueueResult, Error>;
    pub async fn enqueue_many(&self, requests: Vec<EnqueueRequest>) -> Result<Vec<EnqueueResult>, Error>;
    pub async fn cancel(&self, task_id: Uuid, requested_by: &str, reason: Option<&str>)
        -> Result<CancelResult, Error>;
    pub async fn send_signal<P: Serialize>(&self, task_id: Uuid, name: &str, payload: &P,
        options: SignalOptions) -> Result<SignalResult, Error>;
    pub async fn complete_human_wait<P: Serialize>(&self, task_id: Uuid, name: &str, decision: &P,
        options: HumanDecisionOptions) -> Result<HumanWaitResult, Error>;
    pub async fn health(&self) -> Result<Health, Error>;

    pub async fn sync_schedules(&self, namespace: &str, schedules: Vec<ScheduleDefinition>, prune: bool)
        -> Result<SyncReport, Error>;
    pub async fn sync_concurrency_policies(&self, policies: Vec<ConcurrencyPolicy>) -> Result<SyncReport, Error>;
    pub async fn sync_rate_limit_policies(&self, policies: Vec<RateLimitPolicy>) -> Result<SyncReport, Error>;
    pub async fn sync_budgets(&self, budgets: Vec<Budget>) -> Result<SyncReport, Error>;
    pub async fn sync_contracts(&self, contracts: Vec<TaskContract>) -> Result<SyncReport, Error>;

    pub async fn list_concurrency_policies(&self, queues: &[&str]) -> Result<Vec<ConcurrencyPolicy>, Error>;
    pub async fn list_rate_limit_policies(&self, queues: &[&str]) -> Result<Vec<RateLimitPolicy>, Error>;
    pub async fn list_budgets(&self, names: &[&str]) -> Result<Vec<Budget>, Error>;
}
```

`EnqueueOptions` implements `Default` and mirrors Python's field set: `queue`, `priority`,
`concurrency_key`, `budget`, `run_at`, `deadline`, `execution_timeout`, `max_attempts`,
`retry_policy`, `tags`, `idempotency`, `debounce`, `throttle`, and `dependencies`.
`EnqueueResult.outcome` is an enum of `Accepted`, `Replayed`, `Replaced`, `NonReplaceable`, and
`Coalesced`. Rust's `enqueue` and `enqueue_many` return `EnqueueResult`, which carries the task ID
and the outcome. Python's separate `*_with_result` methods therefore have no Rust counterpart. Task
inspection belongs to the operator surface, which Rust does not ship.

### Durable handler context

```rust
#[derive(Clone)]
pub struct HandlerContext { /* Arc over task, token, and durable state */ }

impl HandlerContext {
    pub fn task(&self) -> &ClaimedTask;
    pub fn cancellation(&self) -> &CancellationToken;

    pub async fn checkpoint<T, F, Fut>(&self, name: &str, op: F) -> Result<T, HandlerError>
    where
        T: Serialize + DeserializeOwned,
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, HandlerError>>;

    pub async fn sleep(&self, name: &str, duration: Duration) -> Result<(), Error>;
    pub async fn sleep_until(&self, name: &str, wake_at: DateTime<Utc>) -> Result<(), Error>;
    pub async fn wait_for_signal<T: DeserializeOwned>(&self, name: &str, timeout: Option<Duration>)
        -> Result<SignalOutcome<T>, Error>;
    pub async fn wait_for_human<C: Serialize, T: DeserializeOwned>(&self, name: &str, context: &C,
        timeout: Option<Duration>) -> Result<HumanOutcome<T>, Error>;

    pub async fn run_child<P: Serialize, R: DeserializeOwned>(&self, name: &str, task_type: &str,
        payload: &P, options: EnqueueOptions) -> Result<R, Error>;
    pub async fn run_children(&self, children: Vec<ChildTaskRequest>)
        -> Result<BTreeMap<String, ChildOutcome>, Error>;
    pub async fn run_children_all(&self, children: Vec<ChildTaskRequest>)
        -> Result<BTreeMap<String, serde_json::Value>, Error>;

    pub async fn get_progress<T: DeserializeOwned>(&self) -> Result<Option<T>, Error>;
    pub async fn set_progress<T: Serialize>(&self, progress: &T) -> Result<(), Error>;
}

#[non_exhaustive]
pub enum ChildOutcome {
    Succeeded(serde_json::Value),
    Failed(FailureEnvelope),
    Canceled,
}

pub struct BatchHandlerContext { /* task list, token, checkpoint, progress */ }
```

The context clones cheaply, so a handler can move it into spawned futures. Checkpoint replay runs
`op` only when no checkpoint of that name exists. `run_children` keys its outcomes by child name,
as Python does. Go returns a slice, but a map keeps lookups independent of request order.

Concurrent calls that share one name share one in-flight request, as in Python. A second call
awaits the first call's result instead of issuing its own statement.

`get_checkpoint` and `get_wait` are not part of the first release. Go omits them, and no parity row
requires them. `BatchHandlerContext` offers `task`, `cancellation`, `checkpoint`, `get_progress`,
and `set_progress` only, because ADR 0030 gives batch handlers no suspending or child primitives.

### Suspension

A durable wait that returns `scheduled`, or a child join that returns `created`, suspends the
handler. ADR 0030 defines suspension as releasing the lease and restarting the handler from entry on
resume.

The Rust worker copies Go's mechanism. The context records a suspension flag, cancels the token with
`CancelReason::Suspended`, and returns `Err(Error::Suspended)`. The handler's `?` unwinds the stack.
The worker checks the flag after the handler returns, as Go does in `go/worker.go:1157-1160` after
`go/durability.go:413-416` sets it. A handler that swallows the error still suspends, and the worker
ignores its result. The worker then submits `suspended_for_wait` or `suspended_for_child`.

`Error::Suspended` is hidden from documentation. Handlers should propagate it and never construct
it.

### Fate of `rust/src/durable_context/`

The in-memory model and its `SettlementSink` are deleted. PostgreSQL already owns replay,
idempotency, and settlement through the protocol functions. A second model in memory can only
disagree with it. SM-879 deletes the module and `rust/tests/durable_context.rs`, and reshapes
`durable_postgres.rs` into `rust/src/context.rs`. This change deletes `rust/DURABLE_CONTEXT.md`,
because it documents the rejected design.

### Telemetry

`tracing` is always on. The worker and queue emit spans with the shared names: `workhorse.claim`,
`workhorse.handler`, `workhorse.heartbeat`, `workhorse.retry`, `workhorse.complete`,
`workhorse.recovery`, and `workhorse.maintenance`. Attributes and the outcome enum match
`python/src/workhorse/_telemetry.py` and `go/telemetry.go`. Log events go through `tracing` as
well, so callers choose the subscriber.

The `opentelemetry` feature adds three things.

- Metrics through the global meter `workhorse`, with the shared counter and histogram names.
- W3C trace context injected at enqueue and extracted at claim, bridged through
  `tracing-opentelemetry`.
- The exported limits `TRACE_ATTRIBUTE_COUNT_LIMIT` and `METRIC_ATTRIBUTE_CARDINALITY_LIMIT`, with
  the values Python exports.

Without the feature, the crate pulls no OpenTelemetry dependency.

### Scope and line budget

The SDK is asynchronous only, on Tokio. Rust's PostgreSQL ecosystem is asynchronous, and a
synchronous caller can use `block_on`. The crate has no admin surface, so the operator rows in
`docs/parity.md` stay Absent for Rust. `Queue::cancel` and `Queue::health` are the
application-shaped forms that every queue client carries, not the operator surface.

The budget is 4,000 to 6,000 lines in `rust/src/`, excluding the generated catalogue and tests.
Python and Go both land near 8,000 lines with a synchronous or admin surface Rust omits.

| Module                                                  | Owner  | Contents                                     |
| ------------------------------------------------------- | ------ | -------------------------------------------- |
| `lib.rs`, `types.rs`, `error.rs`, `compatibility.rs`    | SM-877 | re-exports, options, results, the error enum |
| `queue.rs`, `contracts.rs`, `policies.rs`               | SM-877 | `Executor`, `Queue`, and synchronization     |
| `sql_catalogue_generated.rs`                            | SM-877 | generated, outside the budget                |
| `worker/{mod,heartbeat,notifications,batch,process}.rs` | SM-878 | run loop, leases, listener, batches, signals |
| `context.rs`, `waits.rs`, `children.rs`                 | SM-879 | durable context and suspension               |
| `telemetry.rs`                                          | SM-878 | spans, metrics, and trace context            |

## Consequences

### Positive

- Callers learn one crate and one import path. The release lane packages one artifact.
- The Python and Go docs transfer to Rust with renamed identifiers, because the surfaces match.
- The generated catalogue removes hand-written protocol SQL and its argument-order defects.
- Transactional enqueue needs no new API, and SM-874's caller-owned shape fits unchanged.
- A swallowed suspension still suspends, so a handler author cannot corrupt a durable wait by
  catching errors.

### Negative

- Every caller compiles the worker even when they only enqueue. The worker adds little beyond Tokio
  and deadpool, which a Rust service already carries.
- Category variants lose the per-primitive type that Python exposes. The `operation` field restores
  that detail for callers who need it.
- deadpool becomes part of the public API through the worker constructor. A caller on another pool
  must adapt at the boundary.
- The existing `workhorse-client` and `workhorse-worker` names never reach crates.io. Nothing
  depends on them yet, so no migration is owed.

## Rejected alternatives

- **Separate client and worker crates.** Two crates double the release lane and version skew for
  about a thousand lines of separation. Python and Go ship one unit.
- **A `worker` cargo feature.** It saves little compile time and adds a feature matrix to test.
- **A blanket `Executor` implementation over `GenericClient`.** Coherence would forbid the pool
  implementation, and pool-backed queues are the common case.
- **A transaction parameter on each queue method.** It duplicates the executor seam and differs
  from Python and Go.
- **A `Suspend` variant in the handler's return type.** Every durable call site would have to match
  on it, and a missed match would drop a suspension.
- **A durable call that never resolves on suspension.** The handler would never run cleanup, and
  the worker would depend on aborting the task.
- **One error type per primitive.** It triples the enum for no caller benefit, as Go's unwrap
  chain shows.
- **Keeping the in-memory durable model.** It duplicates what PostgreSQL decides and can drift from
  it.
- **A synchronous API.** It doubles the surface, which breaks the line budget.
