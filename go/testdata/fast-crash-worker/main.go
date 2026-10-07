// Command fast-crash-worker serves one fast-tier queue until the crash test kills it. Each handler
// records its task and attempt in fast_crash_invocation, then succeeds.
package main

import (
	"context"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func main() {
	if len(os.Args) != 4 {
		panic("usage: fast-crash-worker DATABASE_URL QUEUE CONCURRENCY")
	}
	databaseURL, queueName := os.Args[1], os.Args[2]
	concurrency, err := strconv.Atoi(os.Args[3])
	if err != nil {
		panic(err)
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		panic(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:        queueName,
		WorkerID:     "go-fast-crashed",
		Concurrency:  concurrency,
		PollInterval: 5 * time.Millisecond,
		PollingOnly:  true,
	})
	if err != nil {
		panic(err)
	}
	worker.Handle("effect", func(handlerContext context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		if _, err := pool.Exec(
			handlerContext,
			"INSERT INTO fast_crash_invocation(task_id, attempt, worker) VALUES ($1::uuid, $2, 'crashed')",
			handler.Task.ID,
			handler.Task.Attempt,
		); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})
	if err := worker.Run(ctx); err != nil {
		panic(err)
	}
}
