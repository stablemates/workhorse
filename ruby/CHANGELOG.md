# Ruby changelog

`stablemates-workhorse` gem versions and release notes live here. The gem carries the version the
other SDKs carry, because every tag names one release of all of them.

## Unreleased

- Add the `Queue` client: `enqueue` and `enqueue_many` with every client enqueue option,
  cancellation, signal and human wait delivery, queue health, and schedule and contract
  synchronization. `sync_concurrency_policies`, `sync_rate_limit_policies`, and `sync_budgets`
  replace a namespace's definitions, and the list methods read them back.
- Durations, including a `RateLimit` interval, are finite Numeric seconds. The client refuses a
  value outside a protocol bound with `ArgumentError` before it sends any statement.
- Contract schemas are checked against the draft 2020-12 meta-schema, and `pattern` matches with
  ECMA-262 semantics.
- Add the executor forms: a `PG::Connection`, a `ConnectionPool`, or any object whose `with`
  yields a connection. `ActiveRecordExecutor` joins the caller's Active Record transaction.
- Add the error hierarchy under `Stablemates::Workhorse::Error`.
