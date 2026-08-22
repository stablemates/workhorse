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
	pool, err := pgxpool.New(ctx, os.Getenv("WORKHORSE_DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	defer pool.Close()

	tx, err := pool.Begin(ctx)
	if err != nil {
		panic(err)
	}
	defer tx.Rollback(ctx)

	// Application writes can use tx here. The job becomes visible only if the
	// caller commits the same transaction.
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(tx), "orders")
	jobID, err := queue.Enqueue(ctx, "order.accepted", map[string]any{
		"orderId": "order-42",
	}, workhorse.EnqueueOptions{
		MaxAttempts: 3,
		RetryPolicy: map[string]any{
			"type": "exponential", "initialDelayMs": 1_000, "multiplier": 2, "maxDelayMs": 60_000,
		},
	})
	if err != nil {
		panic(err)
	}
	if err := tx.Commit(ctx); err != nil {
		panic(err)
	}
	fmt.Println(jobID)
}
