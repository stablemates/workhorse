# Workhorse Rust durable handler context

This crate owns handler-local durability only: checkpoint replay, timers, signal and human-decision
waits, child fan-out/join, and latest-value progress. It does not own the PostgreSQL client,
worker claims, leases, retries, or process lifecycle.

`SettlementSink` is the integration seam for SM-16B. A worker implementation should persist each
settlement intent with the task's fenced settlement transaction. Context state is intentionally
in-memory and replay-safe; SM-16B supplies loading and persistence around handler invocations.
Wait and child names are stable caller keys. A repeated key returns its existing state and does
not execute a producer or overwrite a terminal result. Progress is latest-value storage with a
monotonic local sequence; the worker decides how to publish it to PostgreSQL.
