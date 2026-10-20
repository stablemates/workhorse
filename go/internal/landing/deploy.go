package example

import (
	"context"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func runWorker(ctx context.Context, pool *pgxpool.Pool) error {
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               "email",
		Concurrency:         8,
		ShutdownGracePeriod: 25 * time.Second,
	})
	if err != nil {
		return err
	}
	worker.Handle("email.send", func(
		_ context.Context,
		payload any,
		_ *workhorse.HandlerContext,
	) (any, error) {
		return payload, nil
	})

	runContext, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	return worker.Run(runContext)
}
