package workhorse_test

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func TestWorkerRunKeepsRunningAfterALeaseLoss(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-run-lease-loss")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-run-lease-loss"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	lostID, err := queue.Enqueue(ctx, "lost", nil, workhorse.EnqueueOptions{
		MaxAttempts: 2,
		RetryPolicy: map[string]any{"type": "fixed", "delayMs": 0},
	})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "run-lease-loss-worker",
		LeaseDuration:       time.Second,
		HeartbeatInterval:   20 * time.Millisecond,
		PollInterval:        10 * time.Millisecond,
		MaintenanceInterval: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	lost := make(chan error, 1)
	worker.Handle("lost", func(handlerContext context.Context, _ any, durability *workhorse.HandlerContext) (any, error) {
		if durability.Task.Attempt > 1 {
			return nil, nil
		}
		close(started)
		<-handlerContext.Done()
		lost <- context.Cause(handlerContext)
		return map[string]any{"mustNotSettle": true}, nil
	})
	handled := make(chan string, 1)
	worker.Handle("follow-up", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		handled <- payload.(map[string]any)["value"].(string)
		return nil, nil
	})
	runContext, stop := context.WithCancel(ctx)
	defer stop()
	workerResult := make(chan error, 1)
	go func() { workerResult <- worker.Run(runContext) }()

	<-started
	if _, err := pool.Exec(
		ctx,
		"UPDATE workhorse.task_runtime SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE task_id = $1::uuid",
		lostID,
	); err != nil {
		t.Fatal(err)
	}
	select {
	case cause := <-lost:
		var leaseLost *workhorse.LeaseLostError
		if !errors.As(cause, &leaseLost) || leaseLost.TaskID != lostID {
			t.Fatalf("expected lease-loss cause for %s, received %v", lostID, cause)
		}
	case err := <-workerResult:
		t.Fatalf("worker stopped before the handler observed the lease loss: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("handler never observed the lease loss")
	}

	if _, err := queue.Enqueue(ctx, "follow-up", map[string]any{"value": "after-loss"}); err != nil {
		t.Fatal(err)
	}
	select {
	case value := <-handled:
		if value != "after-loss" {
			t.Fatalf("unexpected follow-up payload %q", value)
		}
	case err := <-workerResult:
		t.Fatalf("worker stopped after a lease loss: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not claim after a lease loss")
	}
	stop()
	if err := <-workerResult; err != nil {
		t.Fatal(err)
	}
}

func TestWorkerLogsAFailingMaintenancePhaseAndKeepsRunning(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-maintenance-phase")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	// tick_v1 catches a phase failure and returns it as data, so a raising promote_v1 models a
	// lock timeout inside the promote phase.
	if _, err := pool.Exec(ctx, `CREATE OR REPLACE FUNCTION workhorse.promote_v1(p_limit integer DEFAULT 100)
		RETURNS integer LANGUAGE plpgsql AS $$
		BEGIN
		  RAISE EXCEPTION 'injected promote failure' USING ERRCODE = '55P03';
		END;
		$$`); err != nil {
		t.Fatal(err)
	}

	var logs lockedBuffer
	queueName := "go-worker-maintenance-phase"
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "maintenance-phase-worker",
		LeaseDuration:       time.Second,
		HeartbeatInterval:   20 * time.Millisecond,
		PollInterval:        10 * time.Millisecond,
		MaintenanceInterval: 20 * time.Millisecond,
		Logger:              slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	handled := make(chan string, 1)
	worker.Handle("after-phase-error", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		handled <- payload.(map[string]any)["value"].(string)
		return nil, nil
	})
	processed, err := worker.RunOnce(ctx)
	if err != nil || processed {
		t.Fatalf("RunOnce stopped on a maintenance phase error: processed=%t err=%v", processed, err)
	}
	runContext, stop := context.WithCancel(ctx)
	defer stop()
	workerResult := make(chan error, 1)
	go func() { workerResult <- worker.Run(runContext) }()

	waitForWorkerLog(t, &logs, "injected promote failure")
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	if _, err := queue.Enqueue(ctx, "after-phase-error", map[string]any{"value": "still-running"}); err != nil {
		t.Fatal(err)
	}
	select {
	case value := <-handled:
		if value != "still-running" {
			t.Fatalf("unexpected payload %q", value)
		}
	case err := <-workerResult:
		t.Fatalf("worker stopped on a maintenance phase error: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not claim after a maintenance phase error")
	}
	stop()
	if err := <-workerResult; err != nil {
		t.Fatal(err)
	}
}

func TestWorkerWithoutALoggerWritesToTheDefaultLogger(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-default-logger")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	var logs lockedBuffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               "go-worker-default-logger",
		WorkerID:            "default-logger-worker",
		LeaseDuration:       time.Second,
		HeartbeatInterval:   20 * time.Millisecond,
		PollInterval:        10 * time.Millisecond,
		MaintenanceInterval: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	runContext, stop := context.WithCancel(ctx)
	defer stop()
	workerResult := make(chan error, 1)
	go func() { workerResult <- worker.Run(runContext) }()

	listenerPID := waitForNotificationListener(t, ctx, pool, 0)
	if _, err := pool.Exec(ctx, "SELECT pg_terminate_backend($1)", listenerPID); err != nil {
		t.Fatal(err)
	}
	waitForWorkerLog(t, &logs, "notification listener unavailable")
	stop()
	if err := <-workerResult; err != nil {
		t.Fatal(err)
	}
}
