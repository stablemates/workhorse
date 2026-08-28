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
