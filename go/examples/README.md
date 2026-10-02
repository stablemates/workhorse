# Go examples

Install the public beta with `go get github.com/stablemates/workhorse/go`, then set
`WORKHORSE_DATABASE_URL` to a database where the Workhorse schema is installed.

- `transaction` enqueues a retryable task inside an application-owned pgx transaction. Its
  `createAccount` function is the documented transactional enqueue, and a test shows that a
  failed enqueue rolls back the account row.
- [`gorm`](gorm/README.md) enqueues through the GORM transaction's `Statement.ConnPool`, using
  the existing SQL executor. Real PostgreSQL tests cover plain and prepared-statement transactions.
- `dedicated-worker` runs a supervised worker with checkpoints, a durable timer, bounded concurrency,
  and signal-driven drain.
- `orchestration` shows child joins, signal waits, and human decisions. Another process supplies
  values with `Queue.SendSignal` and `Queue.CompleteHumanWait`.

Deploy a worker as a dedicated long-lived process. Run the standalone `workhorse dashboard` process
beside it with the same database URL; the dashboard reads PostgreSQL directly and does not need to
be embedded into the Go binary.
