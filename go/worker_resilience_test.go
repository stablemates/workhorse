package workhorse_test

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
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

func TestSlowExpirationDoesNotStallHeartbeatsForOtherTasks(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-slow-expiry")
	ctx := context.Background()
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	// Keep the fixture valid at pgxpool's minimum default capacity, even on a many-core host:
	// the listener, heartbeat, blocked expiry, and observer each need one connection.
	poolConfig.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	// Hold expiry behind a test-owned lock until the lease observations finish. A fixed retry
	// window can end before a loaded host gets enough successful heartbeat rounds to observe.
	// The lock owner must stay outside that pool or it consumes the observer's connection.
	gateConnection, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateConnection.Close(ctx) })
	expiryGate, err := gateConnection.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	releaseExpiry := sync.OnceFunc(func() {
		if err := expiryGate.Rollback(ctx); err != nil {
			t.Error(err)
		}
	})
	defer releaseExpiry()
	const expiryLock = 1103
	var gatePID int32
	if err := expiryGate.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&gatePID); err != nil {
		t.Fatal(err)
	}
	if _, err := expiryGate.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", expiryLock); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE OR REPLACE FUNCTION workhorse.expire_owned_v1(
		p_task_id uuid, p_worker_id text, p_fence_token bigint
	) RETURNS text LANGUAGE plpgsql AS $$
	BEGIN
	  PERFORM pg_advisory_xact_lock(1103);
	  RETURN 'not_due';
	END;
	$$`); err != nil {
		t.Fatal(err)
	}

	var logs lockedBuffer
	queueName := "go-worker-slow-expiry"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	expiringID, err := queue.Enqueue(ctx, "slow-expiry", nil, workhorse.EnqueueOptions{
		MaxAttempts:        1,
		ExecutionTimeoutMS: 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	coRunnerID, err := queue.Enqueue(ctx, "co-runner", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "slow-expiry-worker",
		Concurrency:         2,
		LeaseDuration:       10 * time.Second,
		HeartbeatInterval:   100 * time.Millisecond,
		PollInterval:        10 * time.Millisecond,
		MaintenanceInterval: time.Hour,
		Logger:              slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	expiring := make(chan struct{})
	release := make(chan struct{})
	// Both handlers wait for release, so a failed assertion has to free them before it returns.
	releaseHandlers := sync.OnceFunc(func() { close(release) })
	defer releaseHandlers()
	worker.Handle("slow-expiry", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		// Push the database's copy of the timeout past the worker's own timer. The supervising
		// goroutine then reaches its expiration branch while every heartbeat is still accepted.
		if _, err := pool.Exec(
			ctx,
			"UPDATE workhorse.task_runtime SET attempt_timeout_at = attempt_timeout_at + interval '1 minute' WHERE task_id = $1::uuid",
			expiringID,
		); err != nil {
			return nil, err
		}
		<-handlerContext.Done()
		close(expiring)
		// Keep the handler active until the test finishes observing the co-runner's lease.
		<-release
		return nil, nil
	})
	coRunnerCause := make(chan error, 1)
	worker.Handle("co-runner", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		select {
		case <-handlerContext.Done():
			coRunnerCause <- context.Cause(handlerContext)
		case <-release:
			coRunnerCause <- nil
		}
		return nil, nil
	})
	runContext, stop := context.WithCancel(ctx)
	defer stop()
	workerResult := make(chan error, 1)
	go func() { workerResult <- worker.Run(runContext) }()

	// The handler's cancellation precedes the SQL call, so also wait for the call to reach the gate.
	select {
	case <-expiring:
	case err := <-workerResult:
		t.Fatalf("worker stopped before the expiry window opened: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("the expiring handler never observed its timeout")
	}
	waitForBlockedExpiry(t, ctx, pool, gatePID)
	// If the expiring member stays registered, every subsequent round reports it as non-accepted,
	// which is the shape that used to fill its result channel and block the shared loop.
	requestedBy := "go-test"
	if _, err := queue.Cancel(ctx, expiringID, workhorse.CancellationRequest{RequestedBy: &requestedBy}); err != nil {
		t.Fatal(err)
	}
	// The co-runner keeps renewing throughout the window. A stalled loop would leave its lease
	// frozen where the last accepted round left it.
	assertLeaseKeepsAdvancing(t, ctx, pool, coRunnerID)

	releaseExpiry()
	releaseHandlers()
	select {
	case cause := <-coRunnerCause:
		if cause != nil {
			t.Fatalf("the co-running handler lost its lease during a slow expiry: %v", cause)
		}
	case err := <-workerResult:
		t.Fatalf("worker stopped during a slow expiry: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("the co-running handler never finished")
	}

	handled := make(chan struct{}, 1)
	worker.Handle("after-slow-expiry", func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		handled <- struct{}{}
		return nil, nil
	})
	if _, err := queue.Enqueue(ctx, "after-slow-expiry", nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-handled:
	case err := <-workerResult:
		t.Fatalf("worker stopped after a slow expiry: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not claim after a slow expiry")
	}
	stop()
	if err := <-workerResult; err != nil {
		t.Fatal(err)
	}
}

func waitForBlockedExpiry(t *testing.T, ctx context.Context, pool *pgxpool.Pool, gatePID int32) {
	t.Helper()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var blocked bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM pg_stat_activity
			WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
		)`, gatePID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the expiration call never reached the test's lock")
}

// Observe progress beyond the two rounds that can renew the co-runner before the old blocking
// send stalls: one fills the expiring member's result channel, and the next blocks on it. Each
// observation waits for progress instead of assuming a renewal rate, and expiry stays gated.
func assertLeaseKeepsAdvancing(
	t *testing.T, ctx context.Context, pool *pgxpool.Pool, taskID string,
) {
	t.Helper()
	readExpiry := func() time.Time {
		t.Helper()
		var expiresAt time.Time
		if err := pool.QueryRow(
			ctx,
			"SELECT expires_at FROM workhorse.task_runtime WHERE task_id = $1::uuid",
			taskID,
		).Scan(&expiresAt); err != nil {
			t.Fatal(err)
		}
		return expiresAt
	}
	previous := readExpiry()
	for observation := 1; observation <= 3; observation++ {
		deadline := time.Now().Add(5 * time.Second)
		for {
			time.Sleep(20 * time.Millisecond)
			current := readExpiry()
			if current.After(previous) {
				previous = current
				break
			}
			if !time.Now().Before(deadline) {
				t.Fatalf("task %s lease stopped advancing during the blocked expiry at observation %d (expires_at=%s)",
					taskID, observation, previous.Format(time.RFC3339Nano))
			}
		}
	}
}
