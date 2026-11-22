package workhorse_test

import (
	"context"
	"testing"
	"time"

	workhorse "github.com/stablemates/workhorse/go"
	"go.opentelemetry.io/otel/codes"
)

// The worker releases a claimed task that has no handler, and the release loses its lease. A lost
// lease ends that activation only, as in TypeScript: the worker records lease_lost and continues.
// Before, the Go worker returned the lost lease as an error of the run, and Run stopped.
func TestALostLeaseOfAReleaseLetsTheWorkerContinue(t *testing.T) {
	for _, release := range []struct {
		name string
		// functions replaces protocol functions before the claim.
		functions string
	}{
		{
			// release_owned_v1 answers stale. The reconciliation finds no cancellation, and
			// expire_owned_v1 answers not_due, so the lease is lost.
			name: "stale",
			functions: `CREATE OR REPLACE FUNCTION workhorse.release_owned_v1(
			  p_task_id uuid, p_worker_id text, p_fence_token bigint)
			  RETURNS text LANGUAGE sql AS $body$ SELECT 'stale'::text $body$;`,
		},
		{
			// release_owned_v1 answers cancel_requested, and acknowledge_cancel_v1 refuses it.
			name: "refused-acknowledgement",
			functions: `CREATE OR REPLACE FUNCTION workhorse.release_owned_v1(
			  p_task_id uuid, p_worker_id text, p_fence_token bigint)
			  RETURNS text LANGUAGE sql AS $body$ SELECT 'cancel_requested'::text $body$;
			CREATE OR REPLACE FUNCTION workhorse.acknowledge_cancel_v1(
			  p_task_id uuid, p_worker_id text, p_fence_token bigint)
			  RETURNS boolean LANGUAGE sql AS $body$ SELECT false $body$;`,
		},
	} {
		t.Run(release.name, func(t *testing.T) {
			testALostLeaseOfARelease(t, release.name, release.functions)
		})
	}
}

func testALostLeaseOfARelease(t *testing.T, name, functions string) {
	pool := outcomeTestPool(t, name+"-release-lease-lost")
	ctx := context.Background()
	if _, err := pool.Exec(ctx, functions); err != nil {
		t.Fatal(err)
	}
	queueName := "go-" + name + "-release-lease-lost"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	missingID, err := queue.Enqueue(ctx, "missing", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	reader := installMetricReader(t)
	exporter := installSpanExporter(t)
	var logs lockedBuffer
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName, PollingOnly: true, DisableRegistry: true,
		MaintenanceInterval: time.Hour, PollInterval: 10 * time.Millisecond,
		Logger: debugJSONLogger(&logs),
	})
	if err != nil {
		t.Fatal(err)
	}
	handled := make(chan struct{}, 1)
	worker.Handle("handled", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		handled <- struct{}{}
		return nil, nil
	})

	// RunOnce returns no error, and the release made no progress.
	if processed, err := worker.RunOnce(ctx); err != nil || processed {
		t.Fatalf("RunOnce() = %t, %v, want false, nil", processed, err)
	}
	executions, _ := handlerMetricOutcomes(t, reader, "missing")
	if len(executions) != 1 || executions[0] != "lease_lost" {
		t.Fatalf("workhorse.handler.executions outcomes = %v, want [lease_lost]", executions)
	}
	if records := matchingLogRecords(t, logs.String(), "workhorse.task.execution_finished", map[string]any{
		"workhorse.task.id": missingID, "workhorse.handler.outcome": "lease_lost",
	}); len(records) != 1 {
		t.Fatalf("lease_lost execution records = %v, want one", records)
	}
	span := spanOfTask(t, exporter, "workhorse.handler", missingID)
	if outcome := spanAttribute(span, "workhorse.handler.outcome"); outcome != "stale" {
		t.Fatalf("handler span outcome = %q, want stale", outcome)
	}
	// A lost lease is not an error of the activation, as on the execution path and in TypeScript.
	if span.Status.Code == codes.Error {
		t.Fatalf("handler span status = %v, want no error", span.Status)
	}

	// Run continues after the lost lease. It releases the second task without a handler, loses
	// that lease too, and still runs the handled task. The first released task keeps its lease,
	// so Run cannot claim it again before the lease expires. A Run that stops with the lost lease
	// returns before both happen, or returns the error when it stops.
	secondID, err := queue.Enqueue(ctx, "missing", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Enqueue(ctx, "handled", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	runContext, stop := context.WithCancel(ctx)
	defer stop()
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	ran := false
	deadline := time.After(30 * time.Second)
	for !ran || len(matchingLogRecords(t, logs.String(), "workhorse.task.execution_finished", map[string]any{
		"workhorse.task.id": secondID, "workhorse.handler.outcome": "lease_lost",
	})) != 1 {
		select {
		case <-handled:
			ran = true
		case err := <-runResult:
			t.Fatalf("Run() ended before it released and ran the tasks: %v", err)
		case <-deadline:
			t.Fatalf("Run did not release and run the tasks: handled task ran %t", ran)
		case <-time.After(20 * time.Millisecond):
		}
	}
	stop()
	select {
	case err := <-runResult:
		if err != nil {
			t.Fatalf("Run() = %v, want nil", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Run did not stop")
	}
}

// A release that fails in PostgreSQL settled nothing. It is still an error of the run, as in
// TypeScript, and the attempt has no outcome.
func TestAFailedReleaseIsAnErrorOfTheRun(t *testing.T) {
	pool := outcomeTestPool(t, "failed-release")
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `CREATE OR REPLACE FUNCTION workhorse.release_owned_v1(
	  p_task_id uuid, p_worker_id text, p_fence_token bigint)
	  RETURNS text LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'injected release failure'; END $body$;`); err != nil {
		t.Fatal(err)
	}
	queueName := "go-failed-release"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	if _, err := queue.Enqueue(ctx, "missing", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	reader := installMetricReader(t)
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName, PollingOnly: true, DisableRegistry: true,
		MaintenanceInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("handled", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, nil
	})

	if _, err := worker.RunOnce(ctx); err == nil {
		t.Fatal("RunOnce() = nil, want the release error")
	}
	executions, durations := handlerMetricOutcomes(t, reader, "missing")
	if len(executions) != 0 {
		t.Fatalf("workhorse.handler.executions counted the failed release: %v", executions)
	}
	if len(durations) != 1 || durations[0] != "unknown" {
		t.Fatalf("workhorse.handler.duration outcomes = %v, want [unknown]", durations)
	}
}
