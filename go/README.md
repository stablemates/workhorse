# `github.com/stablemates/workhorse/go`

The Go client, worker runtime, and dashboard handler for the Workhorse durable job queue for
PostgreSQL.

> **Public beta:** Workhorse is usable for evaluation and early production adoption, but 0.x minor
> releases may break compatibility, including the schema. There is no upgrade path between 0.x
> releases; ordered migrations begin at 1.0.0.

An AI agent should read [the Workhorse documentation index](https://workhorse.run/llms.txt) first.

## Install

```bash
go get github.com/stablemates/workhorse/go
```

Install the schema once, as a deployment step. The application never installs or migrates it.

```bash
npx --package @stablemates/workhorse workhorse schema install
```

The machine that runs that deployment step needs Node.js 22 or newer. The application itself needs
no Node.js.

Runtime processes verify compatibility instead of changing the schema. Call `AssertCompatible` at
startup.

Requires Go 1.25 or newer and PostgreSQL 15 through 18. The module pins pgx v5.9.2.

## Run one job

```go
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func main() {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	defer pool.Close()

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "default")
	jobID, err := queue.Enqueue(ctx, "email.welcome", map[string]any{"to": "ada@example.com"})
	if err != nil {
		panic(err)
	}

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{PollingOnly: true})
	if err != nil {
		panic(err)
	}
	worker.Handle("email.welcome", func(
		_ context.Context,
		payload any,
		_ *workhorse.HandlerContext,
	) (any, error) {
		return map[string]any{"deliveredTo": payload.(map[string]any)["to"]}, nil
	})
	if _, err := worker.RunOnce(ctx); err != nil {
		panic(err)
	}

	fmt.Println(jobID)
}
```

Handlers receive at-least-once delivery. Use stable provider idempotency keys around external
effects; named checkpoints prevent completed application stages from running after a later restart.

## Package boundary

This module provides transactional enqueue and worker APIs over caller-owned pgx or `database/sql`
resources. Workers borrow a caller-owned pgx pool for claims and lifecycle calls. The module never
installs or migrates the shared PostgreSQL schema.

## Next

- Follow the [quickstart](https://workhorse.run/docs/quickstart) and deploy
  [worker processes](https://workhorse.run/docs/worker-processes).
- Read the [API reference](https://workhorse.run/docs/api) and
  [compatibility policy](https://workhorse.run/docs/compatibility).
- Use the [operations guide](https://workhorse.run/docs/operations) for telemetry, health, and
  maintenance.
- Browse the [repository](https://github.com/stablemates/workhorse) or report a problem in
  [GitHub issues](https://github.com/stablemates/workhorse/issues).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the module.
