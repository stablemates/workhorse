package example

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func pauseBilling(ctx context.Context, pool *pgxpool.Pool) error {
	admin := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool))
	workers, err := admin.ListWorkers(ctx)
	if err != nil {
		return err
	}
	for _, entry := range workers {
		if entry.Queue != "billing" {
			continue
		}
		if _, err := admin.SetWorkerPaused(ctx, entry.WorkerID, true, workhorse.AdminAudit{
			Actor:     "operator@example.com",
			Reason:    "rolling deploy",
			RequestID: "deploy-2026-08-23:" + entry.WorkerID,
		}); err != nil {
			return err
		}
	}
	return nil
}
