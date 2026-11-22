package workhorse_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// The tests in this file compare the handler outcome of the Go worker with the TypeScript worker:
// the workhorse.handler.outcome of the handler metrics, the workhorse.task.execution_finished
// record, and the outcome of the workhorse.handler span.

// installSpanExporter makes an in-memory exporter the global tracer provider until the test ends.
func installSpanExporter(t *testing.T) *tracetest.InMemoryExporter {
	t.Helper()
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previousProvider := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previousProvider)
		_ = provider.Shutdown(context.Background())
	})
	return exporter
}

// spanOfTask returns the span called name of taskID. It fails the test if there is none.
func spanOfTask(t *testing.T, exporter *tracetest.InMemoryExporter, name, taskID string) tracetest.SpanStub {
	t.Helper()
	for _, span := range exporter.GetSpans() {
		if span.Name != name {
			continue
		}
		if spanAttribute(span, "workhorse.task.id") == taskID {
			return span
		}
	}
	t.Fatalf("no %s span for task %s", name, taskID)
	return tracetest.SpanStub{}
}

// spanAttribute returns the text value of key on span.
func spanAttribute(span tracetest.SpanStub, key string) string {
	attributes := attribute.NewSet(span.Attributes...)
	value, _ := attributes.Value(attribute.Key(key))
	return value.AsString()
}

// recordedExceptionMessages returns the message of each exception event of span.
func recordedExceptionMessages(span tracetest.SpanStub) []string {
	var messages []string
	for _, event := range span.Events {
		if event.Name != "exception" {
			continue
		}
		messages = append(messages, spanAttribute(tracetest.SpanStub{Attributes: event.Attributes}, "exception.message"))
	}
	return messages
}

func outcomeTestPool(t *testing.T, name string) *pgxpool.Pool {
	t.Helper()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), name)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// A heartbeat delivers the cancellation, and acknowledge_cancel_v1 refuses it or fails. The
// attempt settled nothing, so it has no outcome: its duration records unknown, the executions
// counter does not count it, and the worker writes no execution record. The handler span outcome
// is canceled only after PostgreSQL accepts the acknowledgement: a refusal is stale, and a failed
// request is unknown. Before, the Go worker counted the attempt as lease_lost.
func TestARefusedCancellationAcknowledgementHasNoOutcome(t *testing.T) {
	for _, acknowledgement := range []struct {
		name, body, spanOutcome string
		fails                   bool
	}{
		{name: "refused", body: "LANGUAGE sql AS $body$ SELECT false $body$", spanOutcome: "stale"},
		{name: "failed", body: "LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'injected acknowledgement failure'; END $body$", spanOutcome: "unknown", fails: true},
	} {
		t.Run(acknowledgement.name, func(t *testing.T) {
			testAnUnsettledCancellationAcknowledgement(t, acknowledgement.name, acknowledgement.body, acknowledgement.spanOutcome, acknowledgement.fails)
		})
	}
}

func testAnUnsettledCancellationAcknowledgement(t *testing.T, name, body, spanOutcome string, fails bool) {
	pool := outcomeTestPool(t, name+"-cancel-ack-outcome")
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		CREATE OR REPLACE FUNCTION workhorse.acknowledge_cancel_v1(
		  p_task_id uuid, p_worker_id text, p_fence_token bigint)
		  RETURNS boolean `+body); err != nil {
		t.Fatal(err)
	}
	queueName := "go-" + name + "-cancel-ack"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "cancellable", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	reader := installMetricReader(t)
	exporter := installSpanExporter(t)
	var logs lockedBuffer
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName, PollingOnly: true, DisableRegistry: true,
		MaintenanceInterval: time.Hour, LeaseDuration: 3 * time.Second, HeartbeatInterval: 100 * time.Millisecond,
		Logger: debugJSONLogger(&logs),
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("cancellable", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		if _, err := queue.Cancel(ctx, taskID, workhorse.CancellationRequest{}); err != nil {
			return nil, err
		}
		<-handlerContext.Done()
		return nil, handlerContext.Err()
	})
	// A refusal lets the worker continue. A failed request is an error of the run.
	if _, err := worker.RunOnce(ctx); (err != nil) != fails {
		t.Fatalf("RunOnce() = %v, want an error: %v", err, fails)
	}

	executions, durations := handlerMetricOutcomes(t, reader, "cancellable")
	if len(executions) != 0 {
		t.Fatalf("workhorse.handler.executions counted the unsettled cancellation: %v", executions)
	}
	if len(durations) != 1 || durations[0] != "unknown" {
		t.Fatalf("workhorse.handler.duration outcomes = %v, want [unknown]", durations)
	}
	if records := matchingLogRecords(t, logs.String(), "workhorse.task.execution_finished",
		map[string]any{"workhorse.task.id": taskID}); len(records) != 0 {
		t.Fatalf("the refused cancellation wrote an execution record: %v", records)
	}
	span := spanOfTask(t, exporter, "workhorse.handler", taskID)
	if outcome := spanAttribute(span, "workhorse.handler.outcome"); outcome != spanOutcome {
		t.Fatalf("handler span outcome = %q, want %s", outcome, spanOutcome)
	}
}

// A heartbeat reports the deadline, and the handler then asks to cancel its own task before the
// worker asks PostgreSQL to expire it. expire_owned_v1 answers cancel_requested, so the worker
// acknowledges the cancellation, and the task is canceled. The handler outcome is the cause that
// settled, canceled, as in TypeScript. Before, the Go worker reported deadline_exceeded.
func TestACancellationThatSettlesInsteadOfTheExpiryIsTheOutcome(t *testing.T) {
	pool := outcomeTestPool(t, "cancel-before-expiry-outcome")
	ctx := context.Background()
	control, err := pgxpool.New(ctx, pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(control.Close)
	queueName := "go-cancel-before-expiry"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(control), queueName)
	// The deadline is an hour away, so the local expiry timer cannot reach it. Only a heartbeat
	// reports it, after the handler moves it into the past.
	deadline := time.Now().Add(time.Hour)
	taskID, err := queue.Enqueue(ctx, "expiring", map[string]any{}, workhorse.EnqueueOptions{
		MaxAttempts: 1, Deadline: &deadline,
	})
	if err != nil {
		t.Fatal(err)
	}
	reader := installMetricReader(t)
	exporter := installSpanExporter(t)
	var logs lockedBuffer
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName, PollingOnly: true, DisableRegistry: true,
		MaintenanceInterval: time.Hour, LeaseDuration: 3 * time.Second, HeartbeatInterval: 100 * time.Millisecond,
		Logger: debugJSONLogger(&logs),
	})
	if err != nil {
		t.Fatal(err)
	}
	causes := make(chan error, 1)
	worker.Handle("expiring", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		if _, err := control.Exec(ctx, `UPDATE workhorse.task_runtime
			SET deadline_at = clock_timestamp() - interval '1 second' WHERE task_id = $1::uuid`, taskID); err != nil {
			return nil, err
		}
		<-handlerContext.Done()
		causes <- context.Cause(handlerContext)
		if _, err := queue.Cancel(ctx, taskID, workhorse.CancellationRequest{}); err != nil {
			return nil, err
		}
		return nil, handlerContext.Err()
	})
	if _, err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce() = %v, want nil", err)
	}
	if cause := awaitSignal(t, causes, "the handler cancellation"); !errors.Is(cause, workhorse.ErrDeadlineExceeded) {
		t.Fatalf("the handler was cancelled by %v, want the deadline", cause)
	}

	var state string
	if err := control.QueryRow(ctx, `SELECT state FROM workhorse.task_outcome WHERE task_id = $1::uuid`,
		taskID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "canceled" {
		t.Fatalf("task state = %q, want canceled", state)
	}
	executions, durations := handlerMetricOutcomes(t, reader, "expiring")
	if len(executions) != 1 || executions[0] != "canceled" {
		t.Fatalf("workhorse.handler.executions outcomes = %v, want [canceled]", executions)
	}
	if len(durations) != 1 || durations[0] != "canceled" {
		t.Fatalf("workhorse.handler.duration outcomes = %v, want [canceled]", durations)
	}
	requireLogRecord(t, logs.String(), "workhorse.task.execution_finished",
		map[string]any{"workhorse.task.id": taskID, "workhorse.handler.outcome": "canceled"})
	span := spanOfTask(t, exporter, "workhorse.handler", taskID)
	if outcome := spanAttribute(span, "workhorse.handler.outcome"); outcome != "canceled" {
		t.Fatalf("handler span outcome = %q, want canceled", outcome)
	}
}

// A handler returns an error whose Error method panics, and the stop comes while RetryDelay runs.
// The worker recovers the panic and fails the attempt through fail_v1 in the unwind window, so the
// attempt settled. As in TypeScript, the worker writes the execution record of that outcome, and
// the handler span records the failure, not the stop. Before, the Go worker wrote no execution
// record and recorded the shutdown cancellation as the span error.
func TestAPanicOutsideTheHandlerSettledAfterTheStopWritesItsExecutionRecord(t *testing.T) {
	pool := outcomeTestPool(t, "panic-after-stop-outcome")
	ctx := context.Background()
	queueName := "go-panic-after-stop-outcome"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "panicking", map[string]any{}, workhorse.EnqueueOptions{MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	reader := installMetricReader(t)
	exporter := installSpanExporter(t)
	var logs lockedBuffer
	entered, resume := make(chan struct{}), make(chan struct{})
	var calls atomic.Int64
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName, PollingOnly: true, DisableRegistry: true,
		MaintenanceInterval: time.Hour, LeaseDuration: 5 * time.Second, Logger: debugJSONLogger(&logs),
		// The first call waits for the stop. The failure of the panic calls it again.
		RetryDelay: func(int, workhorse.ClaimedTask) *time.Duration {
			if calls.Add(1) == 1 {
				close(entered)
				<-resume
			}
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("panicking", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, panickingError{}
	})
	runContext, stop := context.WithCancel(ctx)
	defer stop()
	runResult := make(chan error, 1)
	go func() {
		_, err := worker.RunOnce(runContext)
		runResult <- err
	}()
	awaitSignal(t, entered, "RetryDelay to start", stop)
	stop()
	close(resume)
	awaitSignal(t, runResult, "RunOnce to return")

	executions, _ := handlerMetricOutcomes(t, reader, "panicking")
	if len(executions) != 1 || executions[0] != "failed" {
		t.Fatalf("workhorse.handler.executions outcomes = %v, want [failed]", executions)
	}
	requireLogRecord(t, logs.String(), "workhorse.task.execution_finished",
		map[string]any{"workhorse.task.id": taskID, "workhorse.handler.outcome": "failed"})
	span := spanOfTask(t, exporter, "workhorse.handler", taskID)
	if outcome := spanAttribute(span, "workhorse.handler.outcome"); outcome != "failed" {
		t.Fatalf("handler span outcome = %q, want failed", outcome)
	}
	for _, message := range recordedExceptionMessages(span) {
		if message == context.Canceled.Error() {
			t.Fatalf("the handler span records the stop as an error: %v", recordedExceptionMessages(span))
		}
	}
}

// The handler span outcome of a failure is the state that fail_v1 returns, as in TypeScript, so a
// failure that starts another attempt is ready or scheduled, not the metric outcome retry.
func TestTheHandlerSpanOfARetryCarriesTheFailureState(t *testing.T) {
	pool := outcomeTestPool(t, "retry-span-outcome")
	ctx := context.Background()
	queueName := "go-retry-span-outcome"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "retrying", map[string]any{}, workhorse.EnqueueOptions{MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	exporter := installSpanExporter(t)
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName, PollingOnly: true, DisableRegistry: true,
		MaintenanceInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("retrying", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, errors.New("the work failed")
	})
	if _, err := worker.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}

	state := spanAttribute(spanOfTask(t, exporter, "workhorse.retry", taskID), "workhorse.retry.outcome")
	if state != "ready" && state != "scheduled" {
		t.Fatalf("fail_v1 state = %q, want ready or scheduled", state)
	}
	if outcome := spanAttribute(spanOfTask(t, exporter, "workhorse.handler", taskID),
		"workhorse.handler.outcome"); outcome != state {
		t.Fatalf("handler span outcome = %q, want the fail_v1 state %q", outcome, state)
	}
}
