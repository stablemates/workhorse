package example

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func inspect(ctx context.Context, pool *pgxpool.Pool) error {
	admin := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool))
	health, err := admin.Health(ctx)
	if err != nil {
		return err
	}
	fmt.Println(health["status"])

	live, err := admin.ListTasks(ctx, workhorse.TaskListQuery{
		States: []workhorse.TaskState{"active", "scheduled"}, Limit: 100,
	})
	if err != nil {
		return err
	}
	fmt.Println(len(live.Items))
	return nil
}
