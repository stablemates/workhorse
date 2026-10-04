// The transactional enqueue the documentation shows: an account row and its task commit or roll
// back together.
//
// Documentation: https://workhorse.run/docs/enqueue

package main

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// createAccount is the transactional enqueue that guide 200 and the enqueue page show. Every
// failure returns before Commit, so the deferred Rollback discards the account row with the task.
//
// docs:start transactional-enqueue
func createAccount(ctx context.Context, pool *pgxpool.Pool, id, email string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, "INSERT INTO account (id, email) VALUES ($1, $2)", id, email); err != nil {
		return err
	}
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(tx), "default")
	if _, err := queue.Enqueue(ctx, "account.created", map[string]any{"accountId": id}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// docs:end
