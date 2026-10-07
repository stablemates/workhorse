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

// SM-1187: a handler that finished its work after its shutdown cancellation and returned a value
// left its task without a settlement. Lease recovery then charged the attempt as lease_expired, so
// the task ran again, or failed on its last attempt, although its handler succeeded. The worker now
// completes the task, as the Rust worker does. A fast-tier task completes alone, outside the
// batches of the stopped dispatch loop.
func TestWorkerCompletesATaskWhoseHandlerReturnsAValueAfterShutdown(t *testing.T) {
	for _, tier := range []workhorse.QueueTier{workhorse.QueueTierFull, workhorse.QueueTierFast} {
		t.Run(string(tier), func(t *testing.T) {
			testWorkerCompletesAfterShutdown(t, tier)
		})
	}
}

func testWorkerCompletesAfterShutdown(t *testing.T, tier workhorse.QueueTier) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-shutdown-complete-"+string(tier))
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-shutdown-complete"
	executor := workhorse.NewPGXExecutor(pool)
	audit := workhorse.AdminAudit{Actor: "shutdown-test", Reason: "SM-1187", RequestID: "SM-1187"}
	if _, err := workhorse.NewAdmin(executor).SetQueueTier(ctx, queueName, tier, audit); err != nil {
		t.Fatal(err)
	}
	queue := workhorse.NewQueue(executor, queueName)
	taskID, err := queue.Enqueue(ctx, "finishing", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "shutdown-complete-worker",
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
		ShutdownGracePeriod: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	worker.Handle("finishing", func(
		handlerContext context.Context,
		_ any,
		_ *workhorse.HandlerContext,
	) (any, error) {
		close(started)
		<-handlerContext.Done()
		return map[string]any{"finished": true}, nil
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

	if tier == workhorse.QueueTierFull {
		assertWorkerFixtureTaskState(t, ctx, pool, taskID, workerFixtureTaskState{
			State: "succeeded", Attempt: 1,
		})
		assertWorkerFixtureAttemptOutcomes(t, ctx, pool, taskID, []string{"succeeded"})
	}
	// A fast-tier task keeps one outcome row, which records every failed attempt in errors.
	statement := `SELECT state, current_attempt, (result->>'finished')::boolean, 0
		FROM workhorse.task_outcome WHERE task_id = $1`
	if tier == workhorse.QueueTierFast {
		statement = `SELECT state, attempt, (result->>'finished')::boolean, jsonb_array_length(errors)
			FROM workhorse.fast_task_outcome WHERE task_id = $1`
	}
	var state string
	var attempt, failedAttempts int
	var finished bool
	if err := pool.QueryRow(ctx, statement, taskID).Scan(
		&state, &attempt, &finished, &failedAttempts,
	); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" || attempt != 1 || failedAttempts != 0 || !finished {
		t.Fatalf("task is %s on attempt %d with %d failed attempts and finished=%t, "+
			"want succeeded on attempt 1 with none and the handler's result",
			state, attempt, failedAttempts, finished)
	}
}

// A caller that cancels the context it passed to RunOnce stops that worker. A handler that still
// returns a value has its task completed.
func TestRunOnceCompletesATaskWhenItsHandlerReturnsAValueAfterTheStop(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-run-once-complete")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-run-once-complete"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "finishing", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "run-once-complete-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	worker.Handle("finishing", func(
		handlerContext context.Context,
		_ any,
		_ *workhorse.HandlerContext,
	) (any, error) {
		close(started)
		<-handlerContext.Done()
		return "finished", nil
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

	assertWorkerFixtureTaskState(t, ctx, pool, taskID, workerFixtureTaskState{
		State: "succeeded", Attempt: 1,
	})
	assertWorkerFixtureAttemptOutcomes(t, ctx, pool, taskID, []string{"succeeded"})
}

// A cancellation request that lands while the handler unwinds from the shutdown makes PostgreSQL
// reject the completion. The worker reconciles that rejection and acknowledges the request, so the
// task closes as canceled instead of waiting for lease recovery.
func TestWorkerAcknowledgesACancellationThatRejectsItsShutdownCompletion(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-shutdown-cancel")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-shutdown-cancel"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "finishing", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "shutdown-cancel-worker",
		LeaseDuration: 10 * time.Second, PollInterval: 5 * time.Millisecond,
		ShutdownGracePeriod: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	worker.Handle("finishing", func(
		handlerContext context.Context,
		_ any,
		_ *workhorse.HandlerContext,
	) (any, error) {
		close(started)
		<-handlerContext.Done()
		if _, err := queue.Cancel(ctx, taskID, workhorse.CancellationRequest{}); err != nil {
			return nil, err
		}
		return "finished", nil
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

	assertWorkerFixtureTaskState(t, ctx, pool, taskID, workerFixtureTaskState{
		State: "canceled", Attempt: 1,
	})
}
