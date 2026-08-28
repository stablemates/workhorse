package workhorse_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestGoWorkerSatisfiesEverySharedRuntimeFixture(t *testing.T) {
	manifest := readFixture[protocolFixtureManifest](t, "manifest.json")
	assertRuntimeManifestCompatibility(t, manifest)
	fixtures := readFixture[[]workerRuntimeFixture](t, "runtime.json")
	executors := map[string]func(*testing.T, workerRuntimeFixture){
		"batch": func(t *testing.T, fixture workerRuntimeFixture) {
			executeWorkerBatchFixture(t, loadBatchRuntimeFixture(t, fixture.ID))
		},
		"suspension-replay":        executeWorkerSuspensionReplayFixture,
		"cooperative-cancellation": executeWorkerCancellationFixture,
		"expiration":               executeWorkerExpirationFixture,
		"lease-loss":               executeWorkerLeaseLossFixture,
		"heartbeat-cadence":        executeWorkerHeartbeatFixture,
		"poll-cadence":             executeWorkerPollCadenceFixture,
		"graceful-drain":           executeWorkerGracefulDrainFixture,
		"trace-propagation":        executeWorkerTracePropagationFixture,
	}
	coverage := make(map[string]struct{}, len(manifest.RuntimeCoverage))
	for _, fixture := range fixtures {
		fixture := fixture
		execute, ok := executors[fixture.Kind]
		if !ok {
			t.Fatalf("unsupported runtime fixture kind %q", fixture.Kind)
		}
		t.Run(fixture.ID, func(t *testing.T) {
			execute(t, fixture)
		})
		for _, capability := range fixture.Covers {
			coverage[capability] = struct{}{}
		}
	}
	actual := make([]string, 0, len(coverage))
	for capability := range coverage {
		actual = append(actual, capability)
	}
	sort.Strings(actual)
	expected := append([]string(nil), manifest.RuntimeCoverage...)
	sort.Strings(expected)
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("runtime fixture coverage differs from the manifest: expected %v, received %v", expected, actual)
	}
}

func executeWorkerTracePropagationFixture(t *testing.T, fixture workerRuntimeFixture) {
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

	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-trace-propagation")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "runtime-" + fixture.ID
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	traceCtx, caller := provider.Tracer("runtime-fixture").Start(ctx, "caller")
	jobID, err := queue.Enqueue(traceCtx, fixture.JobType, map[string]any{})
	caller.End()
	if err != nil {
		t.Fatal(err)
	}
	var stored []byte
	if err := pool.QueryRow(
		ctx,
		"SELECT trace_context FROM workhorse.job WHERE id = $1::uuid",
		jobID,
	).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	var carrier map[string]string
	if err := json.Unmarshal(stored, &carrier); err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(carrier["traceparent"], "-")
	if len(parts) != 4 {
		t.Fatalf("stored traceparent is invalid: %q", carrier["traceparent"])
	}

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-" + fixture.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle(fixture.JobType, func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, nil
	})
	worked, err := worker.RunOnce(ctx)
	if err != nil || !worked {
		t.Fatalf("RunOnce() = %v, %v", worked, err)
	}
	for _, span := range exporter.GetSpans() {
		if span.Name != "workhorse.handler" {
			continue
		}
		if span.SpanContext.TraceID() != caller.SpanContext().TraceID() {
			t.Fatalf("handler trace %s does not match caller trace %s", span.SpanContext.TraceID(), caller.SpanContext().TraceID())
		}
		if span.Parent.SpanID().String() != parts[2] {
			t.Fatalf("handler parent %s does not match stored span %s", span.Parent.SpanID(), parts[2])
		}
		return
	}
	t.Fatal("worker did not export a workhorse.handler span")
}

func executeWorkerPollCadenceFixture(t *testing.T, fixture workerRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-poll-cadence-fixture")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "runtime-" + fixture.ID
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-" + fixture.ID,
		PollInterval:    time.Duration(fixture.PollMS) * time.Millisecond,
		DisableRegistry: true, PollingOnly: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	handled := make(chan time.Time, 1)
	worker.Handle(fixture.JobType, func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		handled <- time.Now()
		return nil, nil
	})
	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	time.Sleep(time.Duration(fixture.IdleMS) * time.Millisecond)
	if _, err := queue.Enqueue(ctx, fixture.JobType, map[string]any{}); err != nil {
		stop()
		t.Fatal(err)
	}
	enqueuedAt := time.Now()
	select {
	case handledAt := <-handled:
		delay := handledAt.Sub(enqueuedAt)
		if delay < time.Duration(fixture.ExpectedMinimumDelayMS)*time.Millisecond ||
			delay > time.Duration(fixture.ExpectedMaximumDelayMS)*time.Millisecond {
			t.Fatalf("poll delay %s fell outside fixture bounds", delay)
		}
	case <-time.After(time.Duration(fixture.ExpectedMaximumDelayMS+1000) * time.Millisecond):
		stop()
		t.Fatal("worker did not claim after the polling backoff")
	}
	stop()
	if err := <-runResult; err != nil {
		t.Fatal(err)
	}
}

func assertRuntimeManifestCompatibility(t *testing.T, manifest protocolFixtureManifest) {
	t.Helper()
	if manifest.FormatVersion != 1 {
		t.Fatalf("unsupported runtime fixture format %d", manifest.FormatVersion)
	}
	if manifest.ProtocolVersion != workhorse.ProtocolVersion {
		t.Fatalf("fixture protocol %d differs from Go protocol %d", manifest.ProtocolVersion, workhorse.ProtocolVersion)
	}
	installed := manifest.Schema.InstalledVersion
	if err := workhorse.CheckCompatibility(&installed, manifest.ProtocolVersion); err != nil {
		t.Fatalf("runtime fixture manifest is incompatible: %v", err)
	}
	if installed < manifest.Schema.MinimumVersion || installed > manifest.Schema.MaximumVersion ||
		manifest.ProtocolVersion < manifest.SupportedClientProtocol.MinimumVersion ||
		manifest.ProtocolVersion > manifest.SupportedClientProtocol.MaximumVersion {
		t.Fatal("runtime fixture manifest declares incompatible schema or client bounds")
	}
}

func executeWorkerGracefulDrainFixture(t *testing.T, fixture workerRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-graceful-drain-fixture")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "runtime-" + fixture.ID
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	jobIDs := make([]string, 0, fixture.JobCount)
	for sequence := range fixture.JobCount {
		jobID, err := queue.Enqueue(ctx, fixture.JobType, map[string]any{"sequence": sequence})
		if err != nil {
			t.Fatal(err)
		}
		jobIDs = append(jobIDs, jobID)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-" + fixture.ID, Concurrency: fixture.Concurrency,
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
		ShutdownGracePeriod: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{}, fixture.JobCount)
	release := make(chan struct{})
	worker.Handle(fixture.JobType, func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		started <- struct{}{}
		<-release
		return nil, nil
	})
	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	for range fixture.ExpectedActiveAtStop {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("worker did not fill its active slots")
		}
	}
	stop()
	select {
	case <-runResult:
		t.Fatal("worker returned before active handlers drained")
	case <-time.After(time.Duration(fixture.SettleCheckMS) * time.Millisecond):
	}
	close(release)
	if err := <-runResult; err != nil {
		t.Fatal(err)
	}
	states := map[string]int{}
	for _, jobID := range jobIDs {
		state := workerFixtureJobStateFor(t, ctx, pool, jobID)
		states[state.State]++
	}
	if states["succeeded"] != fixture.ExpectedSucceeded || states["ready"] != fixture.ExpectedReady {
		t.Fatalf("unexpected drained states: %v", states)
	}
}

func assertWorkerFixtureJobState(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	jobID string,
	expected workerFixtureJobState,
) {
	t.Helper()
	actual := workerFixtureJobStateFor(t, ctx, pool, jobID)
	if actual.State != expected.State || actual.Attempt != expected.Attempt ||
		(expected.ErrorName != "" && actual.ErrorName != expected.ErrorName) {
		t.Fatalf("expected job state %#v, received %#v", expected, actual)
	}
}

func workerFixtureJobStateFor(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	jobID string,
) workerFixtureJobState {
	t.Helper()
	var state workerFixtureJobState
	if err := pool.QueryRow(ctx, `SELECT state, current_attempt, coalesce(error->>'name', '')
		FROM workhorse.job_runtime WHERE job_id = $1::uuid
		UNION ALL
		SELECT state, current_attempt, coalesce(error->>'name', '')
		FROM workhorse.job_outcome WHERE job_id = $1::uuid`, jobID).Scan(
		&state.State,
		&state.Attempt,
		&state.ErrorName,
	); err != nil {
		t.Fatal(err)
	}
	return state
}

func assertWorkerFixtureAttemptOutcomes(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	jobID string,
	expected []string,
) {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT outcome FROM workhorse.attempt_history
		WHERE job_id = $1::uuid ORDER BY attempt`, jobID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	actual := make([]string, 0, len(expected))
	for rows.Next() {
		var outcome string
		if err := rows.Scan(&outcome); err != nil {
			t.Fatal(err)
		}
		actual = append(actual, outcome)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("expected attempt outcomes %v, received %v", expected, actual)
	}
}

func lifecycleCauseName(err error) string {
	var cancellation *workhorse.CancellationRequestedError
	var deadline *workhorse.DeadlineExceededError
	var timeout *workhorse.ExecutionTimeoutError
	var leaseLost *workhorse.LeaseLostError
	switch {
	case errors.As(err, &cancellation):
		return "CancellationRequestedError"
	case errors.As(err, &deadline):
		return "DeadlineExceededError"
	case errors.As(err, &timeout):
		return "ExecutionTimeoutError"
	case errors.As(err, &leaseLost):
		return "LeaseLostError"
	default:
		return fmt.Sprintf("%T", err)
	}
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
