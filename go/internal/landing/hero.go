package example

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

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
	worker.Handle("email.welcome", func(
		_ context.Context, payload any, _ *workhorse.HandlerContext,
	) (any, error) {
		message, ok := payload.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("payload must be an object")
		}
		return map[string]any{"deliveredTo": message["to"]}, nil
	})
	return worker.Run(ctx)
}
