package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func main() {
	runContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(runContext, os.Getenv("WORKHORSE_DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	defer pool.Close()

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               "orders",
		WorkerID:            "orders-worker",
		Concurrency:         8,
		ShutdownGracePeriod: 20 * time.Second,
	})
	if err != nil {
		panic(err)
	}
	worker.Handle("order.accepted", func(
		ctx context.Context,
		payload any,
		handler *workhorse.HandlerContext,
	) (any, error) {
		prepared, err := handler.Checkpoint("prepare", func() (any, error) {
			return map[string]any{"payload": payload, "prepared": true}, nil
		})
		if err != nil {
			return nil, err
		}
		if err := handler.Sleep("provider-backoff", time.Second); err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, context.Cause(ctx)
		}
		return prepared, nil
	})

	if err := worker.Run(runContext); err != nil {
		panic(err)
	}
}
