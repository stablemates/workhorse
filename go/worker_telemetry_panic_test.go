package workhorse_test

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	otelmetric "go.opentelemetry.io/otel/metric"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

// The providers below panic in each operation that the worker calls.

type panickingMeterProvider struct{ metricnoop.MeterProvider }

func (panickingMeterProvider) Meter(string, ...otelmetric.MeterOption) otelmetric.Meter {
	return panickingMeter{}
}

type panickingMeter struct{ metricnoop.Meter }

func (panickingMeter) Int64Counter(string, ...otelmetric.Int64CounterOption) (otelmetric.Int64Counter, error) {
	return panickingInt64Counter{}, nil
}

func (panickingMeter) Float64Counter(
	string,
	...otelmetric.Float64CounterOption,
) (otelmetric.Float64Counter, error) {
	return panickingFloat64Counter{}, nil
}

func (panickingMeter) Int64Histogram(
	string,
	...otelmetric.Int64HistogramOption,
) (otelmetric.Int64Histogram, error) {
	return panickingInt64Histogram{}, nil
}

func (panickingMeter) Float64Histogram(
	string,
	...otelmetric.Float64HistogramOption,
) (otelmetric.Float64Histogram, error) {
	return panickingFloat64Histogram{}, nil
}

type panickingInt64Counter struct{ metricnoop.Int64Counter }

func (panickingInt64Counter) Add(context.Context, int64, ...otelmetric.AddOption) {
	panic("the meter failed")
}

type panickingFloat64Counter struct{ metricnoop.Float64Counter }

func (panickingFloat64Counter) Add(context.Context, float64, ...otelmetric.AddOption) {
	panic("the meter failed")
}

type panickingInt64Histogram struct{ metricnoop.Int64Histogram }

func (panickingInt64Histogram) Record(context.Context, int64, ...otelmetric.RecordOption) {
	panic("the meter failed")
}

type panickingFloat64Histogram struct{ metricnoop.Float64Histogram }

func (panickingFloat64Histogram) Record(context.Context, float64, ...otelmetric.RecordOption) {
	panic("the meter failed")
}

type panickingTracerProvider struct{ tracenoop.TracerProvider }

func (panickingTracerProvider) Tracer(string, ...trace.TracerOption) trace.Tracer {
	return panickingTracer{}
}

type panickingTracer struct{ tracenoop.Tracer }

// Start panics for the retry span and gives the handler span a span whose methods panic.
func (panickingTracer) Start(
	ctx context.Context,
	name string,
	_ ...trace.SpanStartOption,
) (context.Context, trace.Span) {
	if name == "workhorse.retry" {
		panic("the tracer failed")
	}
	return ctx, panickingSpan{}
}

type panickingSpan struct{ tracenoop.Span }

func (panickingSpan) End(...trace.SpanEndOption)              { panic("the span failed") }
func (panickingSpan) AddEvent(string, ...trace.EventOption)   { panic("the span failed") }
func (panickingSpan) RecordError(error, ...trace.EventOption) { panic("the span failed") }
func (panickingSpan) SetStatus(codes.Code, string)            { panic("the span failed") }
func (panickingSpan) SetAttributes(...attribute.KeyValue)     { panic("the span failed") }

type panickingPropagator struct{ propagation.TraceContext }

func (panickingPropagator) Extract(context.Context, propagation.TextMapCarrier) context.Context {
	panic("the propagator failed")
}

// SM-1938: the meter, the tracer, and the propagator belong to the caller, and the worker calls
// them on the execution goroutine and on its own goroutines. A panic there ended the process. The
// worker now drops the measurement or the span operation. Each task settles as it would without
// telemetry, and Run returns at the stop.
func TestWorkerSettlesEachTaskWhenItsTelemetryPanics(t *testing.T) {
	previousMeters, previousTracers := otel.GetMeterProvider(), otel.GetTracerProvider()
	previousPropagator := otel.GetTextMapPropagator()
	otel.SetMeterProvider(panickingMeterProvider{})
	otel.SetTracerProvider(panickingTracerProvider{})
	otel.SetTextMapPropagator(panickingPropagator{})
	t.Cleanup(func() {
		otel.SetMeterProvider(previousMeters)
		otel.SetTracerProvider(previousTracers)
		otel.SetTextMapPropagator(previousPropagator)
	})
	pool, observer := panicTestPool(t, "worker-telemetry-panic")
	ctx := context.Background()
	queueName := "go-telemetry-panic"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	// A stored trace context makes the worker extract it through the propagator.
	traceID, _ := trace.TraceIDFromHex("4bf92f3577b34da6a3ce929d0e0e4736")
	spanID, _ := trace.SpanIDFromHex("00f067aa0ba902b7")
	traced := trace.ContextWithSpanContext(ctx, trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: traceID, SpanID: spanID, TraceFlags: trace.FlagsSampled, Remote: true,
	}))
	once := workhorse.EnqueueOptions{MaxAttempts: 1}
	var taskIDs []string
	for _, taskType := range []string{"succeeding", "failing", "batched"} {
		taskID, err := queue.Enqueue(traced, taskType, nil, once)
		if err != nil {
			t.Fatal(err)
		}
		taskIDs = append(taskIDs, taskID)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName, Concurrency: 2,
		LeaseDuration: 5 * time.Second, PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("succeeding", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return "done", nil
	})
	worker.Handle("failing", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, errors.New("the work failed")
	})
	worker.HandleBatch("batched", workhorse.BatchHandlerOptions{MaxSize: 1},
		func(items []workhorse.BatchHandlerItem) []workhorse.BatchHandlerOutcome {
			return []workhorse.BatchHandlerOutcome{workhorse.BatchSucceeded{Result: "done"}}
		})
	runContext, stop := context.WithCancel(ctx)
	defer stop()
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	outcomes := awaitOutcomes(t, observer, taskIDs, runResult)
	stop()
	if err := awaitSignal(t, runResult, "Run to return after the stop"); err != nil {
		t.Fatalf("Run returned %v", err)
	}
	wants := []tierOutcome{
		{state: "succeeded", attempt: 1},
		{state: "failed", attempt: 1, errorName: "Error", errorMessage: "the work failed"},
		{state: "succeeded", attempt: 1},
	}
	for index, taskID := range taskIDs {
		if outcomes[taskID] != wants[index] {
			t.Fatalf("task %d settled as %+v, want %+v", index, outcomes[taskID], wants[index])
		}
	}
}

// SM-1938: a fast-tier completion commits and claims the next tasks in one statement. If the code
// after that statement panicked, the dispatch loop never got the claimed tasks. Those tasks did
// not run, and Run did not return at the stop, because the loop waited for the claim. The worker
// now hands the claimed tasks to the loop before the panic continues. The worker has one slot, so
// each next task comes from the fused claim.
func TestWorkerRunsTheFusedClaimWhenTheCodeAfterItPanics(t *testing.T) {
	pool, observer := panicTestPool(t, "worker-fused-claim-panic")
	ctx := context.Background()
	queueName := "go-fused-claim-panic"
	makeFastQueue(t, pool, queueName)
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskIDs, err := queue.EnqueueMany(ctx, fastRequests(queueName, "fused", 3))
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName, Concurrency: 1,
		LeaseDuration: 30 * time.Second, PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	arm, fired := workhorse.ArmClaimMetricPanicForTest(worker)
	var first atomic.Bool
	worker.Handle("fused", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		// The claim of the next task counts it after the completion of this one commits.
		if first.CompareAndSwap(false, true) {
			arm()
		}
		return "done", nil
	})
	runContext, stop := context.WithCancel(ctx)
	defer stop()
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	outcomes := awaitFastStates(t, observer, taskIDs, runResult)
	stop()
	select {
	case err := <-runResult:
		if err != nil {
			t.Fatalf("Run returned %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return in 10 s after the stop")
	}
	if !fired() {
		t.Fatal("the claimed counter never panicked")
	}
	for _, taskID := range taskIDs {
		if outcomes[taskID] != "succeeded" {
			t.Fatalf("task %s settled as %q, want succeeded", taskID, outcomes[taskID])
		}
	}
}

// awaitFastStates returns the state of each fast-tier task once every task has an outcome. It fails
// the test after 20 s, or if Run returns first.
func awaitFastStates(t *testing.T, observer *pgx.Conn, taskIDs []string, runResult <-chan error) map[string]string {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		rows, err := observer.Query(context.Background(), `SELECT task_id::text, state
			FROM workhorse.fast_task_outcome WHERE task_id = ANY($1::uuid[])`, taskIDs)
		if err != nil {
			t.Fatal(err)
		}
		outcomes := map[string]string{}
		for rows.Next() {
			var taskID, state string
			if err := rows.Scan(&taskID, &state); err != nil {
				t.Fatal(err)
			}
			outcomes[taskID] = state
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		if len(outcomes) == len(taskIDs) {
			return outcomes
		}
		select {
		case err := <-runResult:
			t.Fatalf("Run returned %v before every task settled", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d of %d tasks settled in 20 s", len(outcomes), len(taskIDs))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// completionPanicTracer is a pgx tracer of the caller that panics once at the start of the first
// complete_v1 statement after it is armed.
type completionPanicTracer struct {
	armed    atomic.Bool
	panicked atomic.Bool
}

func (tracer *completionPanicTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if strings.Contains(data.SQL, "workhorse.complete_v1(") && tracer.armed.CompareAndSwap(true, false) {
		tracer.panicked.Store(true)
		panic("the query tracer failed")
	}
	return ctx
}

func (*completionPanicTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// SM-1938: a pgx tracer of the caller runs inside the query, after pgx took a pool connection and
// before it returns rows to close. The worker recovers a panic there and fails the attempt, but the
// connection stayed out of the pool. The executor now releases the connection on each path.
func TestWorkerReturnsThePoolConnectionWhenTheQueryTracerPanics(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-tracer-panic")
	ctx := context.Background()
	observer, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = observer.Close(context.Background()) })
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 4
	tracer := &completionPanicTracer{}
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	// A lost connection makes Close wait for ever, so a failed test leaves the pool open.
	t.Cleanup(func() {
		if !t.Failed() {
			pool.Close()
		}
	})
	queueName := "go-tracer-panic"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(observer), queueName)
	taskID, err := queue.Enqueue(ctx, "panicking", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName, PollingOnly: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("panicking", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		tracer.armed.Store(true)
		return "done", nil
	})
	runContext, cancel := context.WithTimeout(ctx, workerRunDeadline)
	defer cancel()
	if processed, err := worker.RunOnce(runContext); !processed || err != nil {
		t.Fatalf("RunOnce returned %t, %v", processed, err)
	}
	if !tracer.panicked.Load() {
		t.Fatal("the query tracer never panicked")
	}
	var state, errorName string
	if err := observer.QueryRow(ctx, `SELECT state, coalesce(error->>'name', '') FROM workhorse.task_outcome
		WHERE task_id = $1::uuid`, taskID).Scan(&state, &errorName); err != nil {
		t.Fatal(err)
	}
	if state != "failed" || errorName != "HandlerPanicError" {
		t.Fatalf("the task is %s with %q, want failed with HandlerPanicError", state, errorName)
	}
	acquireContext, stopAcquire := context.WithTimeout(ctx, 5*time.Second)
	defer stopAcquire()
	var held []*pgxpool.Conn
	defer func() {
		for _, conn := range held {
			conn.Release()
		}
	}()
	for range int(config.MaxConns) {
		conn, err := pool.Acquire(acquireContext)
		if err != nil {
			t.Fatalf("the pool gave %d of %d connections: %v", len(held), config.MaxConns, err)
		}
		held = append(held, conn)
	}
}
