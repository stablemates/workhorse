package example

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func createOrder(ctx context.Context, pool *pgxpool.Pool, orderID string, total int) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		"INSERT INTO orders (id, total) VALUES ($1, $2)", orderID, total,
	); err != nil {
		return err
	}
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(tx), "default")
	if _, err := queue.Enqueue(ctx, "order.confirm", map[string]any{
		"orderId": orderID,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
