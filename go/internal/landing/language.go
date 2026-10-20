package example

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func enqueueWelcome(ctx context.Context, pool *pgxpool.Pool) error {
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "default")
	_, err := queue.Enqueue(ctx, "email.welcome", map[string]any{
		"to": "ada@example.com",
	}, workhorse.EnqueueOptions{})
	return err
}
