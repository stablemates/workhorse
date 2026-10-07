package workhorse_test

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// SM-1164: a handler that returned after its shutdown cancellation left its task without a
// settlement. Its lease expired, and lease recovery charged the attempt as lease_expired, so a task
// on its last attempt failed because its worker stopped. The worker now releases the task.
func TestWorkerReleasesATaskWhoseHandlerStopsForShutdown(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-shutdown-release")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-shutdown-release"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "stopping", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "shutdown-release-worker",
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
		ShutdownGracePeriod: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	worker.Handle("stopping", func(
		handlerContext context.Context,
		_ any,
		_ *workhorse.HandlerContext,
	) (any, error) {
		close(started)
		<-handlerContext.Done()
		return nil, context.Cause(handlerContext)
	})

	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	<-started
	stop()
	select {
	case err := <-runResult:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("Run returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run never returned after the grace period")
	}

	var state string
	var attempt int
	if err := pool.QueryRow(ctx, `SELECT state, current_attempt FROM workhorse.task_runtime
		WHERE task_id = $1`, taskID).Scan(&state, &attempt); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || attempt != 1 {
		t.Fatalf("task is %s on attempt %d, want ready on attempt 1", state, attempt)
	}
	rows, err := pool.Query(ctx, `SELECT event_type FROM workhorse.task_event WHERE task_id = $1
		ORDER BY occurred_at, event_id`, taskID)
	if err != nil {
		t.Fatal(err)
	}
	var events []string
	for rows.Next() {
		var event string
		if err := rows.Scan(&event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if want := []string{"enqueued", "claimed", "released"}; !slices.Equal(events, want) {
		t.Fatalf("task events are %v, want %v", events, want)
	}
}

// A caller that cancels the context it passed to RunOnce stops that worker, whatever cause it
// attaches. The handler fails after the stop, so the worker releases its task.
func TestRunOnceReleasesATaskWhenItsCallerCancelsWithACause(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-run-once-release")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-run-once-release"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "stopping", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "run-once-release-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	worker.Handle("stopping", func(
		handlerContext context.Context,
		_ any,
		_ *workhorse.HandlerContext,
	) (any, error) {
		close(started)
		<-handlerContext.Done()
		return nil, context.Cause(handlerContext)
	})
	runContext, stop := context.WithCancelCause(ctx)
	runResult := make(chan error, 1)
	go func() {
		_, err := worker.RunOnce(runContext)
		runResult <- err
	}()
	<-started
	stop(errors.New("the caller is shutting down"))
	select {
	case <-runResult:
	case <-time.After(5 * time.Second):
		t.Fatal("RunOnce never returned after its context ended")
	}

	var state string
	var attempt int
	if err := pool.QueryRow(ctx, `SELECT state, current_attempt FROM workhorse.task_runtime
		WHERE task_id = $1`, taskID).Scan(&state, &attempt); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || attempt != 1 {
		t.Fatalf("task is %s on attempt %d, want ready on attempt 1", state, attempt)
	}
}

// A handler panic fails its attempt, so a panic after the shutdown cancellation keeps the task
// unreleased. Lease recovery settles it, as it did before the worker released stopped handlers.
func TestWorkerKeepsAPanicAfterShutdownUnreleased(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-shutdown-panic")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-shutdown-panic"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "panicking", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "shutdown-panic-worker",
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
		ShutdownGracePeriod: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	worker.Handle("panicking", func(
		handlerContext context.Context,
		_ any,
		_ *workhorse.HandlerContext,
	) (any, error) {
		close(started)
		<-handlerContext.Done()
		panic("the unwind failed")
	})
	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	<-started
	stop()
	select {
	case <-runResult:
	case <-time.After(5 * time.Second):
		t.Fatal("Run never returned after the grace period")
	}

	var released int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM workhorse.task_event
		WHERE task_id = $1 AND event_type = 'released'`, taskID).Scan(&released); err != nil {
		t.Fatal(err)
	}
	if released != 0 {
		t.Fatalf("the worker released a task whose handler panicked after the shutdown")
	}
}
