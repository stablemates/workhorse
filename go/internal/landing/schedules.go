package example

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func runBilling(ctx context.Context, pool *pgxpool.Pool) error {
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "default")
	schedules := []workhorse.ScheduleDefinition{
		{
			Name:     "nightly-invoice-run",
			Schedule: "0 2 * * *",
			Task: workhorse.ScheduledTask{
				Type:    "invoices.generate",
				Payload: map[string]any{},
			},
		},
	}
	if err := queue.SyncSchedules(ctx, "billing", schedules); err != nil {
		return err
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		ScheduleNamespaces: []string{"billing"},
	})
	if err != nil {
		return err
	}
	worker.Handle("invoices.generate", func(
		_ context.Context,
		payload any,
		_ *workhorse.HandlerContext,
	) (any, error) {
		return map[string]any{"generated": true}, nil
	})
	return worker.Run(ctx)
}
