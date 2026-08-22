package workhorse_test

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os/exec"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestGoWorkerMetricsMatchTypeScriptInstrumentCatalog(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	previousProvider := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		otel.SetMeterProvider(previousProvider)
		_ = provider.Shutdown(context.Background())
	})

	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-worker-metrics")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	queueName := "go-worker-metrics"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	if _, err := queue.Enqueue(ctx, "metric-job", nil); err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-metric-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("metric-job", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, nil
	})
	if worked, err := worker.RunOnce(ctx); err != nil || !worked {
		t.Fatalf("RunOnce() = %v, %v", worked, err)
	}
	emitGoFailureMetrics(t, ctx, pool)
	emitGoBatchMetrics(t, ctx, pool)
	emitGoRecoveryMetrics(t, ctx, pool)
	emitGoHeartbeatFailureMetric(t, ctx, pool)

	var collected metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &collected); err != nil {
		t.Fatal(err)
	}
	metrics := make(map[string]metricdata.Metrics)
	for _, scope := range collected.ScopeMetrics {
		for _, instrument := range scope.Metrics {
			metrics[instrument.Name] = instrument
		}
	}
	expected := typeScriptWorkerMetricCatalog(t)
	for name, expectation := range expected {
		instrument, ok := metrics[name]
		if !ok {
			t.Errorf("Go worker did not emit %s", name)
			continue
		}
		if instrument.Unit != expectation.Unit {
			t.Errorf("%s unit = %q, expected %q", name, instrument.Unit, expectation.Unit)
		}
		actualAttributes := metricAttributeKeys(instrument.Data)
		if !slices.Equal(actualAttributes, expectation.Attributes) {
			t.Errorf("%s attributes = %v, TypeScript emits %v", name, actualAttributes, expectation.Attributes)
		}
	}
	if len(metrics) != len(expected) {
		t.Errorf("Go emitted %d worker metrics, TypeScript catalog contains %d: %v", len(metrics), len(expected), metrics)
	}
}

type metricCatalogEntry struct {
	Unit       string   `json:"unit"`
	Attributes []string `json:"attributes"`
}

func typeScriptWorkerMetricCatalog(t *testing.T) map[string]metricCatalogEntry {
	t.Helper()
	command := exec.Command("pnpm", "exec", "tsx", "typescript/core/test/go-telemetry-catalog.ts")
	command.Dir = ".."
	output, err := command.Output()
	if err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			t.Fatalf("TypeScript metric catalog failed: %v\n%s", err, exitError.Stderr)
		}
		t.Fatal(err)
	}
	var catalog map[string]metricCatalogEntry
	if err := json.Unmarshal(output, &catalog); err != nil {
		t.Fatalf("decode TypeScript metric catalog: %v\n%s", err, output)
	}
	return catalog
}

func emitGoFailureMetrics(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	queueName := "go-worker-catalog-failure"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	if _, err := queue.Enqueue(ctx, "catalog-retry", nil, workhorse.EnqueueOptions{
		Priority: 10, MaxAttempts: 2,
		RetryPolicy: map[string]any{"type": "fixed", "delayMs": 60_000},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Enqueue(ctx, "catalog-failure", nil, workhorse.EnqueueOptions{MaxAttempts: 1}); err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-catalog-failure", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	failure := fmt.Errorf("catalog handler failure")
	worker.Handle("catalog-retry", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, failure
	})
	worker.Handle("catalog-failure", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, failure
	})
	for range 2 {
		if worked, err := worker.RunOnce(ctx); err != nil || !worked {
			t.Fatalf("failure metric RunOnce() = %v, %v", worked, err)
		}
	}
}

func emitGoBatchMetrics(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	queueName := "go-worker-catalog-batch"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	if _, err := queue.Enqueue(ctx, "catalog-batch", nil); err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-catalog-batch", Concurrency: 1, LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.HandleBatch(
		"catalog-batch",
		workhorse.BatchHandlerOptions{MaxSize: 1},
		func([]workhorse.BatchHandlerItem) []workhorse.BatchHandlerOutcome {
			return []workhorse.BatchHandlerOutcome{workhorse.BatchSucceeded{}}
		},
	)
	if worked, err := worker.RunOnce(ctx); err != nil || !worked {
		t.Fatalf("batch metric RunOnce() = %v, %v", worked, err)
	}
}

func emitGoRecoveryMetrics(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	queueName := "go-worker-catalog-recovery"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	if _, err := queue.Enqueue(ctx, "catalog-recovery", nil, workhorse.EnqueueOptions{
		MaxAttempts: 2, RetryPolicy: map[string]any{"type": "fixed", "delayMs": 0},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		"SELECT * FROM workhorse.claim_v1($1::text, $2::text, $3::integer)",
		queueName,
		"go-catalog-crashed-peer",
		100,
	); err != nil {
		t.Fatal(err)
	}
	time.Sleep(125 * time.Millisecond)
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-catalog-recovery", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("catalog-recovery", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, nil
	})
	if worked, err := worker.RunOnce(ctx); err != nil || !worked {
		t.Fatalf("recovery metric RunOnce() = %v, %v", worked, err)
	}
}

func emitGoHeartbeatFailureMetric(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	queueName := "go-worker-catalog-heartbeat"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	jobID, err := queue.Enqueue(ctx, "catalog-heartbeat", nil, workhorse.EnqueueOptions{
		MaxAttempts: 2, RetryPolicy: map[string]any{"type": "fixed", "delayMs": 0},
	})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-catalog-heartbeat", LeaseDuration: 100 * time.Millisecond,
		HeartbeatInterval: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	worker.Handle("catalog-heartbeat", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		close(started)
		<-handlerContext.Done()
		return nil, nil
	})
	result := make(chan error, 1)
	go func() {
		_, err := worker.RunOnce(ctx)
		result <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("heartbeat metric handler did not start")
	}
	if _, err := pool.Exec(
		ctx,
		"UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE job_id = $1::uuid",
		jobID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		"SELECT * FROM workhorse.recover_expired_telemetry_v1($1::integer, $2::integer)",
		100,
		nil,
	); err != nil {
		t.Fatal(err)
	}
	select {
	case <-result:
	case <-time.After(time.Second):
		t.Fatal("heartbeat metric worker did not observe lease loss")
	}
}

func TestGoWorkerMetricsDistinguishRetryFromTerminalFailure(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	previousProvider := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		otel.SetMeterProvider(previousProvider)
		_ = provider.Shutdown(context.Background())
	})

	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-worker-failure-metrics")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	queueName := "go-worker-failure-metrics"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	if _, err := queue.Enqueue(ctx, "retry-metric", nil, workhorse.EnqueueOptions{Priority: 10}); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Enqueue(ctx, "failure-metric", nil, workhorse.EnqueueOptions{MaxAttempts: 1}); err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-failure-metric-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	handlerError := fmt.Errorf("expected handler failure")
	worker.Handle("retry-metric", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, handlerError
	})
	worker.Handle("failure-metric", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, handlerError
	})
	for range 2 {
		if worked, err := worker.RunOnce(ctx); err != nil || !worked {
			t.Fatalf("RunOnce() = %v, %v", worked, err)
		}
	}

	var collected metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &collected); err != nil {
		t.Fatal(err)
	}
	metrics := make(map[string]metricdata.Metrics)
	for _, scope := range collected.ScopeMetrics {
		for _, instrument := range scope.Metrics {
			metrics[instrument.Name] = instrument
		}
	}
	failed := metrics["workhorse.jobs.failed"].Data.(metricdata.Sum[int64])
	if !hasMetricPoint(failed.DataPoints, "workhorse.job.type", "retry-metric", "workhorse.attempt.outcome", "scheduled") {
		t.Errorf("failure counter does not carry retry outcome: %#v", failed.DataPoints)
	}
	if !hasMetricPoint(failed.DataPoints, "workhorse.job.type", "failure-metric", "workhorse.attempt.outcome", "failed") {
		t.Errorf("failure counter does not carry terminal outcome: %#v", failed.DataPoints)
	}
	retried := metrics["workhorse.jobs.retried"].Data.(metricdata.Sum[int64])
	if len(retried.DataPoints) != 1 || retried.DataPoints[0].Value != 1 {
		t.Errorf("retried counter = %#v, expected one retried job", retried.DataPoints)
	}
	executions := metrics["workhorse.handler.executions"].Data.(metricdata.Sum[int64])
	if !hasMetricPoint(executions.DataPoints, "workhorse.job.type", "retry-metric", "workhorse.handler.outcome", "retry") {
		t.Errorf("handler executions do not carry retry: %#v", executions.DataPoints)
	}
	if !hasMetricPoint(executions.DataPoints, "workhorse.job.type", "failure-metric", "workhorse.handler.outcome", "failed") {
		t.Errorf("handler executions do not carry terminal failure: %#v", executions.DataPoints)
	}
}

func TestGoWorkerContinuesTypeScriptTraceAndEmitsStructuredLogs(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previousProvider := otel.GetTracerProvider()
	previousPropagator := otel.GetTextMapPropagator()
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		otel.SetTracerProvider(previousProvider)
		otel.SetTextMapPropagator(previousPropagator)
		_ = provider.Shutdown(context.Background())
	})

	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-worker-telemetry")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-telemetry"
	typeScriptEnqueue := enqueueTracedJobFromTypeScript(t, databaseURL, queueName)

	var logs lockedBuffer
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-telemetry-worker",
		LeaseDuration: time.Second,
		Logger: slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{
			Level: slog.LevelDebug,
		})),
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("telemetry", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		if got := trace.SpanContextFromContext(handlerContext); got.TraceID().String() != typeScriptEnqueue.TraceID {
			t.Fatalf("handler trace %s does not continue TypeScript trace %s", got.TraceID(), typeScriptEnqueue.TraceID)
		}
		return nil, nil
	})

	worked, err := worker.RunOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !worked {
		t.Fatal("worker did not claim the traced job")
	}
	var handlerSpan tracetest.SpanStub
	for _, span := range exporter.GetSpans() {
		if span.Name == "workhorse.handler" {
			handlerSpan = span
			break
		}
	}
	if handlerSpan.Name == "" {
		t.Fatal("worker did not export a workhorse.handler span")
	}
	if handlerSpan.SpanKind != trace.SpanKindConsumer {
		t.Fatalf("handler span kind is %s, expected consumer", handlerSpan.SpanKind)
	}
	if handlerSpan.SpanContext.TraceID().String() != typeScriptEnqueue.TraceID || handlerSpan.Parent.SpanID().String() != typeScriptEnqueue.SpanID {
		t.Fatalf("handler span parent is %s/%s, expected %s/%s", handlerSpan.SpanContext.TraceID(), handlerSpan.Parent.SpanID(), typeScriptEnqueue.TraceID, typeScriptEnqueue.SpanID)
	}
	assertSpanAttribute(t, handlerSpan.Attributes, "workhorse.job.id", typeScriptEnqueue.JobID)
	assertSpanAttribute(t, handlerSpan.Attributes, "workhorse.job.type", "telemetry")
	assertSpanAttribute(t, handlerSpan.Attributes, "workhorse.queue.name", queueName)
	assertSpanAttribute(t, handlerSpan.Attributes, "workhorse.handler.outcome", "succeeded")

	logOutput := logs.String()
	for _, event := range []string{
		"workhorse.job.claimed",
		"workhorse.handler.started",
		"workhorse.job.execution_finished",
		"workhorse.handler.finished",
	} {
		if !containsJSONLogEvent(logOutput, event) {
			t.Fatalf("structured logs do not contain event %q: %s", event, logOutput)
		}
	}
	if containsJSONLogValue(logOutput, "never log this") {
		t.Fatalf("structured logs contain the job payload: %s", logOutput)
	}
}

type typeScriptEnqueueTrace struct {
	JobID   string `json:"jobId"`
	TraceID string `json:"traceId"`
	SpanID  string `json:"spanId"`
}

func enqueueTracedJobFromTypeScript(t *testing.T, databaseURL, queueName string) typeScriptEnqueueTrace {
	t.Helper()
	command := exec.Command(
		"pnpm",
		"exec",
		"tsx",
		"typescript/core/test/go-interop-enqueue.ts",
		databaseURL,
		queueName,
	)
	command.Dir = ".."
	output, err := command.Output()
	if err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			t.Fatalf("TypeScript enqueue failed: %s", exitError.Stderr)
		}
		t.Fatal(err)
	}
	var result typeScriptEnqueueTrace
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatalf("decode TypeScript enqueue result: %v: %s", err, output)
	}
	if result.JobID == "" || result.TraceID == "" || result.SpanID == "" {
		t.Fatalf("TypeScript enqueue returned an incomplete trace: %#v", result)
	}
	return result
}

func assertSpanAttribute(t *testing.T, attributes []attribute.KeyValue, key, expected string) {
	t.Helper()
	for _, value := range attributes {
		if string(value.Key) == key && value.Value.AsString() == expected {
			return
		}
	}
	t.Fatalf("span attributes do not contain %s=%q: %#v", key, expected, attributes)
}

func containsJSONLogEvent(output, event string) bool {
	return containsJSONLogValue(output, event)
}

func containsJSONLogValue(output, value string) bool {
	encoded, _ := json.Marshal(value)
	return len(output) >= len(encoded) && stringContains(output, string(encoded))
}

func stringContains(value, substring string) bool {
	for index := 0; index+len(substring) <= len(value); index++ {
		if value[index:index+len(substring)] == substring {
			return true
		}
	}
	return false
}

func metricAttributes(aggregation metricdata.Aggregation) attribute.Set {
	switch data := aggregation.(type) {
	case metricdata.Sum[int64]:
		return data.DataPoints[0].Attributes
	case metricdata.Sum[float64]:
		return data.DataPoints[0].Attributes
	case metricdata.Histogram[int64]:
		return data.DataPoints[0].Attributes
	case metricdata.Histogram[float64]:
		return data.DataPoints[0].Attributes
	default:
		return attribute.NewSet()
	}
}

func metricAttributeKeys(aggregation metricdata.Aggregation) []string {
	set := metricAttributes(aggregation)
	attributes := set.ToSlice()
	keys := make([]string, len(attributes))
	for index, value := range attributes {
		keys[index] = string(value.Key)
	}
	slices.Sort(keys)
	return keys
}

func hasMetricPoint(
	points []metricdata.DataPoint[int64],
	firstKey, firstValue, secondKey, secondValue string,
) bool {
	for _, point := range points {
		first, firstExists := point.Attributes.Value(attribute.Key(firstKey))
		second, secondExists := point.Attributes.Value(attribute.Key(secondKey))
		if firstExists && secondExists && first.AsString() == firstValue && second.AsString() == secondValue {
			return true
		}
	}
	return false
}
