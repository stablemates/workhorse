# Go examples

Install the public beta with `go get github.com/stablemates/workhorse/go@v0.1.0-beta.1`, then set
`WORKHORSE_DATABASE_URL` to a database where the Workhorse schema is installed.

- `transaction` enqueues a retryable job inside an application-owned pgx transaction.
- `dedicated-worker` runs a supervised worker with checkpoints, a durable timer, bounded concurrency,
  and signal-driven drain.
- `orchestration` shows child joins, signal waits, and human decisions. Another process supplies
  values with `Queue.SendSignal` and `Queue.CompleteHumanWait`.

Deploy a worker as a dedicated long-lived process. Run the standalone `workhorse dashboard` process
beside it with the same database URL; the dashboard reads PostgreSQL directly and does not need to
be embedded into the Go binary.
