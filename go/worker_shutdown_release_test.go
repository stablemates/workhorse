package workhorse_test

import (
	"context"
	"errors"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
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
	awaitSignal(t, started, "the handler to start", stop)
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
	awaitSignal(t, started, "the handler to start", func() { stop(nil) })
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

// SM-1943: a handler panic fails its attempt, also after the shutdown cancellation. The worker
// used to leave the task active, so lease recovery charged the attempt as LeaseExpired and no
// attempt record held the panic. It now fails the attempt with HandlerPanicError on the unwind
// window, as the Rust worker does, and does not release the task.
func TestWorkerKeepsAPanicAfterShutdownUnreleased(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previousProvider := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previousProvider)
		_ = provider.Shutdown(context.Background())
	})
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
	awaitSignal(t, started, "the handler to start", stop)
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
	assertWorkerFixtureTaskState(t, ctx, pool, taskID, workerFixtureTaskState{
		State: "failed", Attempt: 1, ErrorName: "HandlerPanicError",
	})
	var outcome, errorName string
	if err := pool.QueryRow(ctx, `SELECT outcome, error->>'name' FROM workhorse.attempt_history
		WHERE task_id = $1`, taskID).Scan(&outcome, &errorName); err != nil {
		t.Fatal(err)
	}
	if outcome != "failed" || errorName != "HandlerPanicError" {
		t.Fatalf("the attempt record is %s with %q, want failed with HandlerPanicError", outcome, errorName)
	}
	// The handler span reports the panic as its only exception, not the cancellation of Run.
	var handlerSpans int
	for _, span := range exporter.GetSpans() {
		if span.Name != "workhorse.handler" {
			continue
		}
		handlerSpans++
		exceptions := 0
		for _, event := range span.Events {
			if event.Name == "exception" {
				exceptions++
			}
		}
		if span.Status.Code != codes.Error || span.Status.Description != "handler failed" || exceptions != 1 {
			t.Fatalf("the handler span has status %v %q and %d exceptions, want one exception and handler failed",
				span.Status.Code, span.Status.Description, exceptions)
		}
	}
	if handlerSpans != 1 {
		t.Fatalf("the worker exported %d handler spans, want 1", handlerSpans)
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
	awaitSignal(t, started, "the handler to start", stop)
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
	awaitSignal(t, started, "the handler to start", func() { stop(nil) })
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
	awaitSignal(t, started, "the handler to start", stop)
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

// ADR 0117 limits the release to the unwind window. A handler that fails during the shutdown
// grace, before the worker cancels it, keeps its usual settlement: fail_v1 charges the attempt,
// and a task on its last attempt fails.
func TestWorkerFailsAHandlerThatFailsBeforeItsShutdownCancellation(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-shutdown-early-failure")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-shutdown-early-failure"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "failing", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "shutdown-early-failure-worker",
		PollInterval: 5 * time.Millisecond, ShutdownGracePeriod: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	stopped := make(chan struct{})
	cancelled := make(chan bool, 1)
	worker.Handle("failing", func(
		handlerContext context.Context,
		_ any,
		_ *workhorse.HandlerContext,
	) (any, error) {
		close(started)
		<-stopped
		cancelled <- handlerContext.Err() != nil
		return nil, errors.New("the work failed")
	})
	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	awaitSignal(t, started, "the handler to start", stop)
	stop()
	close(stopped)
	select {
	case err := <-runResult:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("Run returned %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run never returned after the stop")
	}
	if <-cancelled {
		t.Fatal("the shutdown cancelled the handler before it failed")
	}
	assertWorkerFixtureTaskState(t, ctx, pool, taskID, workerFixtureTaskState{State: "failed", Attempt: 1})
}

// ADR 0117: a batch member records the return of the batch handler and its result before the
// failure evidence write. A stop during that write cannot turn the failure into a release, and the
// attempt record keeps the error of the batch handler, not the cancellation.
func TestWorkerKeepsABatchFailureWhenTheStopComesDuringItsEvidence(t *testing.T) {
	for _, test := range []struct {
		name, errorName, message string
		panics                   bool
	}{
		{
			name: "missing-outcomes", errorName: "Error",
			message: "batch handler for late-batch returned 0 outcomes for 2 tasks",
		},
		{
			name: "panic", errorName: "HandlerPanicError", panics: true,
			message: "batch handler for late-batch panicked: the batch failed",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			testBatchFailureDuringEvidence(t, test.panics, test.errorName, test.message)
		})
	}
}

func testBatchFailureDuringEvidence(t *testing.T, panics bool, errorName, message string) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-shutdown-batch-evidence-"+errorName)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `
		CREATE FUNCTION public.hold_batch_failure() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN PERFORM pg_advisory_xact_lock(921933); RETURN NEW; END $$;
		CREATE TRIGGER hold_batch_failure BEFORE INSERT ON workhorse.task_event
		FOR EACH ROW WHEN (NEW.event_type = 'batch_failed')
		EXECUTE FUNCTION public.hold_batch_failure()`); err != nil {
		t.Fatal(err)
	}
	// The lock holder and the poll below use a connection outside the pool of the worker. The
	// worker can hold every connection of its pool while the evidence write waits for this lock,
	// and a pool of four connections then has none left for the test.
	hold, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = hold.Close(context.Background()) }()
	if _, err := hold.Exec(ctx, "SELECT pg_advisory_lock(921933)"); err != nil {
		t.Fatal(err)
	}
	unlocked := false
	unlock := func() {
		if !unlocked {
			unlocked = true
			if _, err := hold.Exec(ctx, "SELECT pg_advisory_unlock(921933)"); err != nil {
				t.Error(err)
			}
		}
	}
	defer unlock()

	queueName := "go-worker-shutdown-batch-evidence"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskIDs := make([]string, 2)
	for index := range taskIDs {
		if taskIDs[index], err = queue.Enqueue(ctx, "late-batch", nil, workhorse.EnqueueOptions{
			MaxAttempts: 1,
		}); err != nil {
			t.Fatal(err)
		}
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "shutdown-batch-evidence-worker", Concurrency: 2,
		PollInterval: 5 * time.Millisecond, ShutdownGracePeriod: time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	var cancelledAtReturn atomic.Int32
	worker.HandleBatch("late-batch", workhorse.BatchHandlerOptions{
		MaxSize: 2, Linger: time.Minute,
	}, func(items []workhorse.BatchHandlerItem) []workhorse.BatchHandlerOutcome {
		for _, item := range items {
			if item.Context.Context.Err() != nil {
				cancelledAtReturn.Add(1)
			}
		}
		if panics {
			panic("the batch failed")
		}
		// No outcomes for two members fails the whole batch.
		return nil
	})
	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var waiting int
		if err := hold.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event = 'advisory'
			AND query LIKE '%record_batch_failure_v1%'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			stop()
			t.Fatal("the failure evidence never waited")
		}
		time.Sleep(5 * time.Millisecond)
	}
	stop()
	// The grace ends and the worker cancels both members while the evidence write still waits.
	time.Sleep(100 * time.Millisecond)
	unlock()
	select {
	case <-runResult:
	case <-time.After(10 * time.Second):
		t.Fatal("Run never returned after the stop")
	}
	if cancelledAtReturn.Load() != 0 {
		t.Fatal("the shutdown cancelled a member before the batch handler returned")
	}
	for _, taskID := range taskIDs {
		assertWorkerFixtureTaskState(t, ctx, pool, taskID, workerFixtureTaskState{
			State: "failed", Attempt: 1, ErrorName: errorName,
		})
		var recorded string
		if err := pool.QueryRow(ctx, `SELECT error->>'message' FROM workhorse.task_outcome
			WHERE task_id = $1`, taskID).Scan(&recorded); err != nil {
			t.Fatal(err)
		}
		if recorded != message {
			t.Fatalf("the task failed with %q, want %q", recorded, message)
		}
	}
}
