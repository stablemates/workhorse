package workhorse_test

import (
	"context"
	"errors"
	"fmt"
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
)

// refusedSettlementCase is one change that makes PostgreSQL refuse a settlement write, and the
// handler outcome that the worker reports after it settles the cause.
type refusedSettlementCase struct {
	cause   string
	outcome string
}

// refusedCompletionCases are the causes of the shared fixture a-refused-completion-settles-its-cause.
var refusedCompletionCases = []refusedSettlementCase{
	{cause: "deadline", outcome: "deadline_exceeded"},
	{cause: "attempt-timeout", outcome: "timeout"},
	{cause: "cancellation", outcome: "canceled"},
	{cause: "moved-fence", outcome: "lease_lost"},
}

// lapsedLeaseCases let the lease expire under an unchanged fence, so fail_v1 and release_owned_v1
// answer stale. A due boundary still settles under that fence. A cancellation cannot be
// acknowledged after the lease expires, so it stays with lease recovery.
var lapsedLeaseCases = []refusedSettlementCase{
	{cause: "lapsed-deadline", outcome: "deadline_exceeded"},
	{cause: "lapsed-attempt-timeout", outcome: "timeout"},
	{cause: "lapsed-lease", outcome: "lease_lost"},
}

// A refused completion reports the cause that the worker settles as its handler outcome, on the
// handler span and on the handler executions metric. Only a moved fence reports a lost lease.
func TestWorkerReportsTheSettledCauseOfARefusedCompletionAsTheHandlerOutcome(t *testing.T) {
	testRefusedSettlementOutcomes(t, "worker-refused-complete", refusedCompletionCases, false, false)
}

// A handler that returns a value after the stop has its completion written by the shutdown
// settlement. A refusal there reports the same outcomes as a refusal of a normal completion.
func TestWorkerReportsTheSettledCauseOfARefusedShutdownCompletionAsTheHandlerOutcome(t *testing.T) {
	testRefusedSettlementOutcomes(t, "worker-refused-shutdown-complete", refusedCompletionCases, false, true)
}

// A failure that fail_v1 answers stale reports the cause that the reconciliation settles.
func TestWorkerReportsTheSettledCauseOfAStaleFailureAsTheHandlerOutcome(t *testing.T) {
	testRefusedSettlementOutcomes(t, "worker-refused-fail", lapsedLeaseCases, true, false)
}

// A shutdown release that release_owned_v1 answers stale reports the cause that the
// reconciliation settles.
func TestWorkerReportsTheSettledCauseOfAStaleShutdownReleaseAsTheHandlerOutcome(t *testing.T) {
	testRefusedSettlementOutcomes(t, "worker-refused-release", lapsedLeaseCases, true, true)
}

func testRefusedSettlementOutcomes(
	t *testing.T,
	name string,
	cases []refusedSettlementCase,
	handlerFails, afterStop bool,
) {
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

	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), name)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	// The handler changes its task through a separate pool, outside the worker's connections.
	control, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(control.Close)

	taskIDs := make(map[string]string, len(cases))
	for _, testCase := range cases {
		taskIDs[testCase.cause] = runRefusedSettlement(
			t, ctx, pool, control, name, testCase.cause, handlerFails, afterStop,
		)
	}

	var collected metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &collected); err != nil {
		t.Fatal(err)
	}
	var executions metricdata.Sum[int64]
	for _, scope := range collected.ScopeMetrics {
		for _, instrument := range scope.Metrics {
			if instrument.Name == "workhorse.handler.executions" {
				executions = instrument.Data.(metricdata.Sum[int64])
			}
		}
	}
	spanOutcomes := make(map[string]string)
	for _, span := range exporter.GetSpans() {
		if span.Name != "workhorse.handler" {
			continue
		}
		attributes := attribute.NewSet(span.Attributes...)
		taskID, _ := attributes.Value("workhorse.task.id")
		outcome, _ := attributes.Value("workhorse.handler.outcome")
		spanOutcomes[taskID.AsString()] = outcome.AsString()
	}
	for _, testCase := range cases {
		t.Run(testCase.cause, func(t *testing.T) {
			if outcome := spanOutcomes[taskIDs[testCase.cause]]; outcome != testCase.outcome {
				t.Errorf("handler span outcome = %q, want %q", outcome, testCase.outcome)
			}
			if !hasMetricPoint(
				executions.DataPoints,
				"workhorse.task.type", testCase.cause,
				"workhorse.handler.outcome", testCase.outcome,
			) {
				t.Errorf("handler executions carry no %q point: %#v", testCase.outcome, executions.DataPoints)
			}
		})
	}
}

// runRefusedSettlement runs one task whose handler changes the task so that PostgreSQL refuses the
// settlement write. With handlerFails, the handler returns an error instead of a value. With
// afterStop, the handler returns after RunOnce's context ends.
func runRefusedSettlement(
	t *testing.T,
	ctx context.Context,
	pool, control *pgxpool.Pool,
	name, cause string,
	handlerFails, afterStop bool,
) string {
	t.Helper()
	queueName := name + "-" + cause
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	controlQueue := workhorse.NewQueue(workhorse.NewPGXExecutor(control), queueName)
	// The enqueued boundaries are far away, so the worker's own timers cannot reach them.
	deadline := time.Now().Add(time.Hour)
	taskID, err := queue.Enqueue(ctx, cause, map[string]any{}, workhorse.EnqueueOptions{
		MaxAttempts:        1,
		Deadline:           &deadline,
		ExecutionTimeoutMS: int(time.Hour / time.Millisecond),
	})
	if err != nil {
		t.Fatalf("%s: %v", cause, err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:             queueName,
		WorkerID:          queueName,
		LeaseDuration:     10 * time.Second,
		HeartbeatInterval: 5 * time.Second,
		DisableRegistry:   true,
		// With an interval of one hour, only the tick before the claim runs. A later tick could
		// settle the changed boundary before the settlement write.
		MaintenanceInterval: time.Hour,
	})
	if err != nil {
		t.Fatalf("%s: %v", cause, err)
	}
	runContext, stop := context.WithCancel(ctx)
	defer stop()
	started := make(chan struct{})
	handlerFailure := make(chan error, 1)
	worker.Handle(cause, func(handlerContext context.Context, _ any, durability *workhorse.HandlerContext) (any, error) {
		close(started)
		if afterStop {
			<-handlerContext.Done()
		}
		handlerFailure <- refuseSettlement(ctx, control, controlQueue, cause, durability.Task.ID)
		if handlerFails {
			return nil, errors.New("the handler failed")
		}
		return map[string]any{"late": true}, nil
	})
	runResult := make(chan error, 1)
	go func() {
		_, err := worker.RunOnce(runContext)
		runResult <- err
	}()
	timeout := time.After(10 * time.Second)
	select {
	case <-started:
	case err := <-runResult:
		t.Fatalf("%s: RunOnce() = %v before the handler started", cause, err)
	case <-timeout:
		t.Fatalf("%s: the handler never started", cause)
	}
	if afterStop {
		stop()
	}
	select {
	case err := <-runResult:
		if err != nil && !afterStop {
			t.Fatalf("%s: RunOnce() = %v, want nil", cause, err)
		}
	case <-timeout:
		t.Fatalf("%s: RunOnce never returned", cause)
	}
	if err := <-handlerFailure; err != nil {
		t.Fatalf("%s: the handler could not change its task: %v", cause, err)
	}
	return taskID
}

// refuseSettlement changes the task so that PostgreSQL refuses its next settlement write.
func refuseSettlement(
	ctx context.Context,
	control *pgxpool.Pool,
	controlQueue *workhorse.Queue,
	cause, taskID string,
) error {
	past := "clock_timestamp() - interval '1 second'"
	var change string
	switch cause {
	case "deadline":
		change = "deadline_at = " + past
	case "attempt-timeout":
		change = "attempt_timeout_at = " + past
	case "cancellation":
		result, err := controlQueue.Cancel(ctx, taskID, workhorse.CancellationRequest{})
		if err == nil && result.Status != workhorse.CancelRequested {
			err = fmt.Errorf("cancel status %q, want %q", result.Status, workhorse.CancelRequested)
		}
		return err
	case "moved-fence":
		change = "fence_token = fence_token + 1, deadline_at = " + past
	case "lapsed-deadline":
		change = "expires_at = " + past + ", deadline_at = " + past
	case "lapsed-attempt-timeout":
		change = "expires_at = " + past + ", attempt_timeout_at = " + past
	case "lapsed-lease":
		change = "expires_at = " + past
	default:
		return fmt.Errorf("unknown refused-settlement cause %q", cause)
	}
	_, err := control.Exec(ctx, "UPDATE workhorse.task_runtime SET "+change+" WHERE task_id = $1::uuid", taskID)
	return err
}
