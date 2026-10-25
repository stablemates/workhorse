package workhorse_test

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// retryTelemetryCase is one attempt that fails or reaches its attempt timeout. The name is also
// the queue and the task type. With final, the attempt is the last one.
type retryTelemetryCase struct {
	name    string
	tier    workhorse.QueueTier
	timeout bool
	final   bool
}

// Each fail_v1 write records one workhorse.retry span, and an attempt timeout records one only when
// expire_owned_telemetry_v1 starts another attempt. Each retry adds one workhorse.tasks.retried
// count. Both tiers behave the same, as in the TypeScript worker (SM-1734). The span is a child of
// the handler span, carries the task attributes and workhorse.retry.outcome, and is active while the
// worker writes the failure and its log record.
func TestWorkerRecordsTheRetrySpanAndCountOfEachRetry(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	exporter := tracetest.NewInMemoryExporter()
	tracerProvider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previousMeterProvider := otel.GetMeterProvider()
	previousTracerProvider := otel.GetTracerProvider()
	otel.SetMeterProvider(meterProvider)
	otel.SetTracerProvider(tracerProvider)
	t.Cleanup(func() {
		otel.SetMeterProvider(previousMeterProvider)
		otel.SetTracerProvider(previousTracerProvider)
		_ = meterProvider.Shutdown(context.Background())
		_ = tracerProvider.Shutdown(context.Background())
	})
	pool := fastTierPool(t, "go-worker-retry-telemetry")
	logs := &failureLogSpans{spans: map[string]trace.SpanID{}}
	logger := slog.New(logs)

	cases := []retryTelemetryCase{
		{name: "full-failure", tier: workhorse.QueueTierFull},
		{name: "fast-failure", tier: workhorse.QueueTierFast},
		{name: "full-timeout", tier: workhorse.QueueTierFull, timeout: true},
		{name: "fast-timeout", tier: workhorse.QueueTierFast, timeout: true},
		{name: "full-final-failure", tier: workhorse.QueueTierFull, final: true},
		{name: "full-final-timeout", tier: workhorse.QueueTierFull, timeout: true, final: true},
		{name: "fast-final-timeout", tier: workhorse.QueueTierFast, timeout: true, final: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			taskID := runRetriedAttempt(t, pool, logger, testCase)

			var handlerSpan tracetest.SpanStub
			var retrySpans []tracetest.SpanStub
			for _, span := range exporter.GetSpans() {
				attributes := attribute.NewSet(span.Attributes...)
				if id, _ := attributes.Value("workhorse.task.id"); id.AsString() != taskID {
					continue
				}
				switch span.Name {
				case "workhorse.handler":
					handlerSpan = span
				case "workhorse.retry":
					retrySpans = append(retrySpans, span)
				}
			}
			// A final attempt timeout starts no attempt, so retry_state is null and no span starts.
			wantSpans := 1
			if testCase.timeout && testCase.final {
				wantSpans = 0
			}
			wantOutcomes := []string{"ready", "scheduled"}
			if testCase.final {
				wantOutcomes = []string{"failed"}
			}
			if len(retrySpans) != wantSpans {
				t.Errorf("workhorse.retry spans = %d, want %d", len(retrySpans), wantSpans)
			} else if wantSpans == 1 {
				checkRetrySpan(t, retrySpans[0], handlerSpan, testCase.name, wantOutcomes)
				if !testCase.timeout && logs.span(taskID) != retrySpans[0].SpanContext.SpanID() {
					t.Errorf("the failure log record has span %s, want the retry span %s",
						logs.span(taskID), retrySpans[0].SpanContext.SpanID())
				}
			}

			wantRetried := int64(1)
			if testCase.final {
				wantRetried = 0
			}
			if retried := retriedCount(t, reader, testCase.name); retried != wantRetried {
				t.Errorf("workhorse.tasks.retried for queue %s = %d, want %d", testCase.name, retried, wantRetried)
			}
		})
	}
}

// runRetriedAttempt runs one attempt of a task on its own queue and returns the task ID. The handler
// fails, or it waits until its attempt timeout ends it.
func runRetriedAttempt(
	t *testing.T,
	pool *pgxpool.Pool,
	logger *slog.Logger,
	testCase retryTelemetryCase,
) string {
	t.Helper()
	ctx := context.Background()
	if testCase.tier == workhorse.QueueTierFast {
		makeFastQueue(t, pool, testCase.name)
	}
	options := workhorse.EnqueueOptions{MaxAttempts: 3}
	if testCase.final {
		options.MaxAttempts = 1
	}
	if testCase.timeout {
		options.ExecutionTimeoutMS = 300
	}
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), testCase.name)
	taskID, err := queue.Enqueue(ctx, testCase.name, map[string]any{}, options)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:             testCase.name,
		WorkerID:          testCase.name,
		LeaseDuration:     10 * time.Second,
		HeartbeatInterval: 5 * time.Second,
		DisableRegistry:   true,
		Logger:            logger,
		// Only the tick before the claim runs, so maintenance cannot settle the attempt timeout.
		MaintenanceInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle(testCase.name, func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		if testCase.timeout {
			<-handlerContext.Done()
			return nil, context.Cause(handlerContext)
		}
		return nil, errors.New("the handler failed")
	})
	runContext, stop := context.WithTimeout(ctx, 30*time.Second)
	defer stop()
	if worked, err := worker.RunOnce(runContext); err != nil || !worked {
		t.Fatalf("RunOnce() = %v, %v", worked, err)
	}
	return taskID
}

// checkRetrySpan holds one retry span to the TypeScript span: a child of the handler span, with the
// task ID, type, and attempt, and one of outcomes as workhorse.retry.outcome.
func checkRetrySpan(t *testing.T, retry, handler tracetest.SpanStub, taskType string, outcomes []string) {
	t.Helper()
	if retry.Parent.SpanID() != handler.SpanContext.SpanID() {
		t.Errorf("retry span parent = %s, want the handler span %s",
			retry.Parent.SpanID(), handler.SpanContext.SpanID())
	}
	attributes := attribute.NewSet(retry.Attributes...)
	if attributes.Len() != 4 {
		t.Errorf("retry span attributes = %v, want the task id, type, attempt, and outcome", retry.Attributes)
	}
	if value, _ := attributes.Value("workhorse.task.type"); value.AsString() != taskType {
		t.Errorf("workhorse.task.type = %q, want %q", value.AsString(), taskType)
	}
	if value, _ := attributes.Value("workhorse.task.attempt"); value.AsInt64() != 1 {
		t.Errorf("workhorse.task.attempt = %d, want 1", value.AsInt64())
	}
	outcome, _ := attributes.Value("workhorse.retry.outcome")
	for _, want := range outcomes {
		if outcome.AsString() == want {
			return
		}
	}
	t.Errorf("workhorse.retry.outcome = %q, want one of %v", outcome.AsString(), outcomes)
}

// retriedCount reads the workhorse.tasks.retried count of one queue.
func retriedCount(t *testing.T, reader *sdkmetric.ManualReader, queue string) int64 {
	t.Helper()
	var collected metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &collected); err != nil {
		t.Fatal(err)
	}
	var retried int64
	for _, scope := range collected.ScopeMetrics {
		for _, instrument := range scope.Metrics {
			if instrument.Name != "workhorse.tasks.retried" {
				continue
			}
			for _, point := range instrument.Data.(metricdata.Sum[int64]).DataPoints {
				if name, _ := point.Attributes.Value("workhorse.queue.name"); name.AsString() == queue {
					retried += point.Value
				}
			}
		}
	}
	return retried
}

// failureLogSpans is a slog handler that keeps, for each task, the span that is active when the
// worker logs workhorse.task.failure_processed.
type failureLogSpans struct {
	mu    sync.Mutex
	spans map[string]trace.SpanID
}

func (logs *failureLogSpans) Enabled(context.Context, slog.Level) bool { return true }

func (logs *failureLogSpans) Handle(ctx context.Context, record slog.Record) error {
	var event, taskID string
	record.Attrs(func(attribute slog.Attr) bool {
		switch attribute.Key {
		case "event.name":
			event = attribute.Value.String()
		case "workhorse.task.id":
			taskID = attribute.Value.String()
		}
		return true
	})
	if event == "workhorse.task.failure_processed" {
		logs.mu.Lock()
		logs.spans[taskID] = trace.SpanContextFromContext(ctx).SpanID()
		logs.mu.Unlock()
	}
	return nil
}

func (logs *failureLogSpans) WithAttrs([]slog.Attr) slog.Handler { return logs }

func (logs *failureLogSpans) WithGroup(string) slog.Handler { return logs }

func (logs *failureLogSpans) span(taskID string) trace.SpanID {
	logs.mu.Lock()
	defer logs.mu.Unlock()
	return logs.spans[taskID]
}
