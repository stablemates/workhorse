package example

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

type welcome struct {
	To string `json:"to"`
}

func run(ctx context.Context, pool *pgxpool.Pool) error {
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "default")
	if _, err := queue.Enqueue(ctx, "email.welcome", map[string]any{
		"to": "ada@example.com",
	}); err != nil {
		return err
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{Concurrency: 4})
	if err != nil {
		return err
	}
	worker.Handle("email.welcome", workhorse.Typed(func(
		_ context.Context, message welcome, _ *workhorse.HandlerContext,
	) (any, error) {
		return map[string]any{"deliveredTo": message.To}, nil
	}))
	return worker.Run(ctx)
}
