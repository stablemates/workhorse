package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func main() {
	if len(os.Args) != 5 {
		panic("usage: process-worker DATABASE_URL QUEUE MODE WORKER_ID")
	}
	databaseURL, queueName, mode, workerID := os.Args[1], os.Args[2], os.Args[3], os.Args[4]
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		panic(err)
	}
	defer pool.Close()

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            workerID,
		LeaseDuration:       200 * time.Millisecond,
		HeartbeatInterval:   50 * time.Millisecond,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: 20 * time.Millisecond,
		ShutdownGracePeriod: 2 * time.Second,
		PollingOnly:         true,
	})
	if err != nil {
		panic(err)
	}
	worker.Handle("process.fixture", func(handlerContext context.Context, payload any, handler *workhorse.HandlerContext) (any, error) {
		if _, err := pool.Exec(
			handlerContext,
			"INSERT INTO process_fixture_invocation(job_id, worker_id, attempt) VALUES ($1::uuid, $2::text, $3::integer)",
			handler.Job.ID,
			workerID,
			handler.Job.Attempt,
		); err != nil {
			return nil, err
		}
		switch mode {
		case "drain":
			for {
				var released bool
				if err := pool.QueryRow(handlerContext, "SELECT released FROM process_fixture_control WHERE name = 'drain'").Scan(&released); err != nil {
					return nil, err
				}
				if released {
					return map[string]any{"drained": true}, nil
				}
				time.Sleep(5 * time.Millisecond)
			}
		case "crash":
			<-handlerContext.Done()
			return nil, context.Cause(handlerContext)
		case "recover":
			return map[string]any{"recovered": true, "payload": payload}, nil
		default:
			return nil, fmt.Errorf("unknown fixture mode %q", mode)
		}
	})

	if mode == "recover" {
		processed, err := worker.RunOnce(ctx)
		if err != nil {
			panic(err)
		}
		if !processed {
			panic("recovery worker did not process a job")
		}
		return
	}

	runContext, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := worker.Run(runContext); err != nil && !errors.Is(err, context.Canceled) {
		panic(err)
	}
}
