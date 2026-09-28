package workhorse_test

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// observeDatabase opens one connection outside the worker's pool, so a test can read task state
// while every pooled connection is held.
func observeDatabase(t *testing.T, ctx context.Context, databaseURL string) *pgx.Conn {
	t.Helper()
	observer, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = observer.Close(context.Background()) })
	return observer
}

func leaseExpiry(t *testing.T, ctx context.Context, observer *pgx.Conn, taskID string) time.Time {
	t.Helper()
	var expiresAt *time.Time
	if err := observer.QueryRow(
		ctx,
		"SELECT expires_at FROM workhorse.task_runtime WHERE task_id = $1::uuid",
		taskID,
	).Scan(&expiresAt); err != nil {
		t.Fatal(err)
	}
	if expiresAt == nil {
		t.Fatal("claimed task has no lease expiry")
	}
	return *expiresAt
}

// waitForLeaseRenewal waits until the lease expiry moves past previous, which only an accepted
// heartbeat does.
func waitForLeaseRenewal(
	t *testing.T,
	ctx context.Context,
	observer *pgx.Conn,
	taskID string,
	previous time.Time,
	within time.Duration,
) time.Time {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		expiresAt := leaseExpiry(t, ctx, observer, taskID)
		if expiresAt.After(previous) {
			return expiresAt
		}
		if time.Now().After(deadline) {
			t.Fatalf("lease was not renewed within %s", within)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestWorkerHeartbeatsRenewWhileHandlersHoldEveryOtherPooledConnection pins the reservation: a
// heartbeat never queues behind handlers, because its connection left the pool before they ran.
func TestWorkerHeartbeatsRenewWhileHandlersHoldEveryOtherPooledConnection(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-reserved-heartbeat")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 3
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	observer := observeDatabase(t, ctx, databaseURL)

	queueName := "go-worker-reserved-heartbeat"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "reserved-heartbeat", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "reserved-heartbeat-worker",
		LeaseDuration:       5 * time.Second,
		HeartbeatInterval:   20 * time.Millisecond,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	worker.Handle("reserved-heartbeat", func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		close(started)
		<-release
		return nil, nil
	})
	workerResult := make(chan error, 1)
	go func() {
		processed, err := worker.RunOnce(ctx)
		if err == nil && !processed {
			err = errors.New("worker did not process the reserved-heartbeat task")
		}
		workerResult <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not start the handler")
	}

	// Take every connection the pool can still lend. The reservation left before the handler ran,
	// so the heartbeat round does not compete for these.
	held := make([]*pgxpool.Conn, 0, int(config.MaxConns))
	for {
		acquireContext, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
		connection, err := pool.Acquire(acquireContext)
		cancel()
		if err != nil {
			break
		}
		held = append(held, connection)
	}
	if len(held) == 0 {
		t.Fatal("the pool lent no connection to the starving test")
	}
	expiresAt := leaseExpiry(t, ctx, observer, taskID)
	renewed := waitForLeaseRenewal(t, ctx, observer, taskID, expiresAt, 2*time.Second)
	waitForLeaseRenewal(t, ctx, observer, taskID, renewed, 2*time.Second)
	for _, connection := range held {
		connection.Release()
	}

	close(release)
	select {
	case err := <-workerResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not settle the starved task")
	}
	var state string
	if err := observer.QueryRow(
		ctx,
		"SELECT state FROM workhorse.task_outcome WHERE task_id = $1::uuid",
		taskID,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" {
		t.Fatalf("expected the starved attempt to succeed, received %s", state)
	}
}

// TestNewWorkerRefusesAPoolThatCannotLendAHeartbeatConnection pins the construction refusal and its
// opt-out, so an operator learns about the risk instead of inheriting it silently.
func TestNewWorkerRefusesAPoolThatCannotLendAHeartbeatConnection(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-heartbeat-capacity")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	if _, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-worker-heartbeat-capacity",
	}); err == nil {
		t.Fatal("expected a pool of 2 connections to refuse a worker")
	} else {
		for _, fragment := range []string{"MaxConns", "2", "SharedHeartbeats"} {
			if !strings.Contains(err.Error(), fragment) {
				t.Fatalf("refusal does not name %q: %v", fragment, err)
			}
		}
	}
	if _, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:            "go-worker-heartbeat-capacity",
		SharedHeartbeats: true,
	}); err != nil {
		t.Fatalf("expected the opt-out to run on a pool of 2 connections: %v", err)
	}
}

// TestWorkerRetriesAFailedHeartbeatRoundAndKeepsTasksRunning pins the retry: a round that fails is
// unknown, not a lease loss, so the handler keeps running and the next round renews the lease.
func TestWorkerRetriesAFailedHeartbeatRoundAndKeepsTasksRunning(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-heartbeat-retry")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	observer := observeDatabase(t, ctx, databaseURL)

	var logs lockedBuffer
	queueName := "go-worker-heartbeat-retry"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "heartbeat-retry", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "heartbeat-retry-worker",
		LeaseDuration:       10 * time.Second,
		HeartbeatInterval:   20 * time.Millisecond,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: 20 * time.Millisecond,
		Logger:              slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	cancelled := make(chan struct{}, 1)
	worker.Handle("heartbeat-retry", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		close(started)
		select {
		case <-release:
		case <-handlerContext.Done():
			cancelled <- struct{}{}
		}
		return nil, nil
	})
	workerResult := make(chan error, 1)
	go func() {
		processed, err := worker.RunOnce(ctx)
		if err == nil && !processed {
			err = errors.New("worker did not process the heartbeat-retry task")
		}
		workerResult <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not start the handler")
	}
	claimed := leaseExpiry(t, ctx, observer, taskID)
	waitForLeaseRenewal(t, ctx, observer, taskID, claimed, 2*time.Second)

	// Kill the session the reserved connection heartbeats on. The next round fails on it, and the
	// round after that renews on a connection the pool lends fresh.
	terminateHeartbeatSession(t, ctx, observer)
	waitForWorkerLog(t, &logs, "heartbeat round failed; retrying")
	select {
	case <-cancelled:
		t.Fatal("a failed heartbeat round cancelled the handler")
	default:
	}
	failed := leaseExpiry(t, ctx, observer, taskID)
	waitForLeaseRenewal(t, ctx, observer, taskID, failed, 2*time.Second)

	close(release)
	select {
	case err := <-workerResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not settle the task whose heartbeat round failed")
	}
	var state string
	if err := observer.QueryRow(
		ctx,
		"SELECT state FROM workhorse.task_outcome WHERE task_id = $1::uuid",
		taskID,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" {
		t.Fatalf("expected the retried attempt to succeed, received %s", state)
	}
}

// terminateHeartbeatSession ends the backend the reserved connection sent its last heartbeat on.
func terminateHeartbeatSession(t *testing.T, ctx context.Context, observer *pgx.Conn) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		var terminated bool
		err := observer.QueryRow(
			ctx,
			`SELECT pg_terminate_backend(pid)
			 FROM pg_stat_activity
			 WHERE datname = current_database()
			   AND pid <> pg_backend_pid()
			   AND query LIKE '%heartbeat_many_v1%'
			 LIMIT 1`,
		).Scan(&terminated)
		if err == nil && terminated {
			return
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("no heartbeat session was found to terminate")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestWorkerWatchdogCancelsAHandlerAfterALeaseWithoutAnAcceptedHeartbeat pins the local watchdog: a
// heartbeat that never answers still ends the attempt, because by then a peer may own the task.
func TestWorkerWatchdogCancelsAHandlerAfterALeaseWithoutAnAcceptedHeartbeat(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-lease-watchdog")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	// Every heartbeat statement stalls for longer than the lease, which is what a heartbeat that
	// never returns looks like to the worker.
	config.ConnConfig.Tracer = newHeartbeatQueryTracer(time.Second)
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	observer := observeDatabase(t, ctx, databaseURL)

	var logs lockedBuffer
	queueName := "go-worker-lease-watchdog"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "lease-watchdog", nil)
	if err != nil {
		t.Fatal(err)
	}
	leaseDuration := 300 * time.Millisecond
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "lease-watchdog-worker",
		LeaseDuration:       leaseDuration,
		HeartbeatInterval:   20 * time.Millisecond,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: time.Minute,
		Logger:              slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan time.Time, 1)
	causes := make(chan error, 1)
	worker.Handle("lease-watchdog", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		started <- time.Now()
		<-handlerContext.Done()
		causes <- context.Cause(handlerContext)
		return nil, nil
	})
	workerResult := make(chan error, 1)
	go func() {
		processed, err := worker.RunOnce(ctx)
		if err == nil && !processed {
			err = errors.New("worker did not process the lease-watchdog task")
		}
		workerResult <- err
	}()
	var claimedAt time.Time
	select {
	case claimedAt = <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not start the handler")
	}
	select {
	case cause := <-causes:
		if !errors.Is(cause, workhorse.ErrLeaseLost) {
			t.Fatalf("expected the watchdog to cancel the handler with a lost lease, received %v", cause)
		}
		if elapsed := time.Since(claimedAt); elapsed > 3*leaseDuration {
			t.Fatalf("watchdog waited %s for a lease of %s", elapsed, leaseDuration)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("watchdog did not cancel the handler within a lease")
	}
	select {
	case err := <-workerResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not return after the watchdog fired")
	}
	if !strings.Contains(logs.String(), "workhorse.handler.outcome=lease_lost") {
		t.Fatalf("expected a lease_lost execution outcome, logged:\n%s", logs.String())
	}
	// A lost lease is recorded, not settled: lease recovery owns the task now, so this worker must
	// not submit a failure for it.
	var settled bool
	if err := observer.QueryRow(
		ctx,
		"SELECT EXISTS (SELECT 1 FROM workhorse.task_outcome WHERE task_id = $1::uuid)",
		taskID,
	).Scan(&settled); err != nil {
		t.Fatal(err)
	}
	if settled {
		t.Fatal("the watchdog settled a task whose lease it had already lost")
	}
}

// heartbeatSessionPID waits for a backend other than the observer's that last ran a heartbeat,
// skipping the session named by previous, and returns its pid.
func heartbeatSessionPID(t *testing.T, ctx context.Context, observer *pgx.Conn, previous uint32) uint32 {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		var pid uint32
		err := observer.QueryRow(
			ctx,
			`SELECT pid
			 FROM pg_stat_activity
			 WHERE datname = current_database()
			   AND pid <> pg_backend_pid()
			   AND pid <> $1
			   AND query LIKE '%heartbeat_many_v1%'
			 LIMIT 1`,
			previous,
		).Scan(&pid)
		if err == nil {
			return pid
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("no heartbeat session was found")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestWorkerRunSurvivesTheTerminationOfItsIdleHeartbeatConnection pins the idle case: PostgreSQL
// may end the reserved heartbeat session while no task runs, and Run keeps running. The next task's
// first round fails on the dead session, and the round after renews on a fresh connection.
func TestWorkerRunSurvivesTheTerminationOfItsIdleHeartbeatConnection(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-idle-heartbeat-termination")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	observer := observeDatabase(t, ctx, databaseURL)

	var logs lockedBuffer
	queueName := "go-worker-idle-heartbeat-termination"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "idle-heartbeat-termination-worker",
		LeaseDuration:       10 * time.Second,
		HeartbeatInterval:   20 * time.Millisecond,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: 20 * time.Millisecond,
		Logger:              slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan string, 2)
	releases := map[string]chan struct{}{"before": make(chan struct{}), "after": make(chan struct{})}
	cancelled := make(chan string, 2)
	worker.Handle("idle-heartbeat", func(handlerContext context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		document, _ := payload.(map[string]any)
		name, _ := document["name"].(string)
		started <- name
		select {
		case <-releases[name]:
		case <-handlerContext.Done():
			cancelled <- name
		}
		return nil, nil
	})
	runContext, stopRun := context.WithCancel(ctx)
	defer stopRun()
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()

	runTask := func(name string, previousSession uint32) uint32 {
		t.Helper()
		taskID, err := queue.Enqueue(ctx, "idle-heartbeat", map[string]any{"name": name})
		if err != nil {
			t.Fatal(err)
		}
		select {
		case startedName := <-started:
			if startedName != name {
				t.Fatalf("expected task %q to start, received %q", name, startedName)
			}
		case <-time.After(5 * time.Second):
			select {
			case err := <-runResult:
				t.Fatalf("Run returned before task %q started: %v", name, err)
			default:
			}
			t.Fatalf("worker did not start task %q, logged:\n%s", name, logs.String())
		}
		claimed := leaseExpiry(t, ctx, observer, taskID)
		waitForLeaseRenewal(t, ctx, observer, taskID, claimed, 2*time.Second)
		session := heartbeatSessionPID(t, ctx, observer, previousSession)
		close(releases[name])
		deadline := time.Now().Add(5 * time.Second)
		for {
			var state string
			err := observer.QueryRow(
				ctx,
				"SELECT state FROM workhorse.task_outcome WHERE task_id = $1::uuid",
				taskID,
			).Scan(&state)
			if err == nil {
				if state != "succeeded" {
					t.Fatalf("expected task %q to succeed, received %s", name, state)
				}
				return session
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				t.Fatal(err)
			}
			if time.Now().After(deadline) {
				t.Fatalf("worker did not settle task %q", name)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}

	before := runTask("before", 0)
	// The worker is idle now, and its reservation still holds the session that heartbeated.
	var terminated bool
	if err := observer.QueryRow(ctx, "SELECT pg_terminate_backend($1)", before).Scan(&terminated); err != nil {
		t.Fatal(err)
	}
	if !terminated {
		t.Fatalf("heartbeat session %d was not terminated", before)
	}
	time.Sleep(100 * time.Millisecond)
	select {
	case err := <-runResult:
		t.Fatalf("Run returned while idle after its heartbeat session ended: %v", err)
	default:
	}

	after := runTask("after", before)
	if after == before {
		t.Fatalf("heartbeats resumed on the terminated session %d", before)
	}
	select {
	case name := <-cancelled:
		t.Fatalf("the terminated heartbeat session cancelled task %q", name)
	default:
	}
	select {
	case err := <-runResult:
		t.Fatalf("Run returned before its context was cancelled: %v", err)
	default:
	}

	stopRun()
	select {
	case err := <-runResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}
	// The reservation held the dead session through the idle stretch, so a round must have failed
	// on it before the fresh connection renewed.
	if !strings.Contains(logs.String(), "heartbeat round failed; retrying") {
		t.Fatalf("no heartbeat round failed on the terminated session, logged:\n%s", logs.String())
	}
}
