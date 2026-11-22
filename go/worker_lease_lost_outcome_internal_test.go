package workhorse

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"testing"

	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// statementExecutor answers each protocol statement with its rows, or fails it with its error.
type statementExecutor struct {
	rows   map[string][]Row
	errors map[string]error
}

func (executor statementExecutor) Query(_ context.Context, sql string, _ ...any) ([]Row, error) {
	for name, statement := range protocolStatementRegistry {
		if statement != sql {
			continue
		}
		if err, ok := executor.errors[name]; ok {
			return nil, err
		}
		if rows, ok := executor.rows[name]; ok {
			return rows, nil
		}
	}
	return nil, fmt.Errorf("unexpected statement: %s", sql)
}

// A task without a handler is released, release_owned_v1 answers cancel_requested, and PostgreSQL
// then refuses the acknowledgement. The worker lost the lease, so the handler metrics count the
// outcome lease_lost, as on the execution path. Before, they counted canceled.
func TestARefusedReleaseAcknowledgementIsALostLease(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	previousProvider := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		otel.SetMeterProvider(previousProvider)
		_ = provider.Shutdown(context.Background())
	})
	worker := newDefaultWorker(t, WorkerOptions{})
	task := ClaimedTask{
		ID:         "11111111-1111-1111-1111-111111111111",
		Type:       "missing",
		Queue:      "defaults",
		Attempt:    1,
		FenceToken: 7,
	}
	executor := statementExecutor{rows: map[string][]Row{
		releaseOwnedStatementName:      {{rowStatusField: workerFailureCancelRequested}},
		acknowledgeCancelStatementName: {{rowAcceptedField: false}},
	}}

	err := worker.release(context.Background(), executor, task)

	if !errors.Is(err, ErrStaleLease) {
		t.Fatalf("expected the lost lease, received %v", err)
	}
	var collected metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &collected); err != nil {
		t.Fatal(err)
	}
	var executions []string
	for _, scope := range collected.ScopeMetrics {
		for _, instrument := range scope.Metrics {
			if sum, ok := instrument.Data.(metricdata.Sum[int64]); ok && instrument.Name == handlerExecutionsInstrument {
				for _, point := range sum.DataPoints {
					outcome, _ := point.Attributes.Value(handlerOutcomeAttribute)
					executions = append(executions, outcome.AsString())
				}
			}
		}
	}
	if len(executions) != 1 || executions[0] != string(handlerOutcomeLeaseLost) {
		t.Fatalf("workhorse.handler.executions outcomes = %v, want [lease_lost]", executions)
	}
}

// A failure write after the shutdown cancellation answers stale. The worker lost the lease, so the
// outcome is lease_lost. Before, it was canceled, although no cancellation settled.
func TestAStaleFailureWriteAfterTheStopIsALostLease(t *testing.T) {
	worker := &Worker{
		workerID: "shutdown-worker",
		logger:   slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)),
	}
	task := ClaimedTask{
		ID:         "11111111-1111-1111-1111-111111111111",
		Type:       "send-invoice",
		Queue:      "billing",
		Attempt:    2,
		FenceToken: 7,
	}
	executor := statementExecutor{errors: map[string]error{
		failStatementName: &StaleLeaseError{TaskID: task.ID},
	}}

	outcome, err := worker.failAfterShutdown(context.Background(), executor, task, errors.New("handler failed"))

	if !errors.Is(err, ErrStaleLease) {
		t.Fatalf("expected the lost lease, received %v", err)
	}
	if outcome != handlerOutcomeLeaseLost {
		t.Fatalf("expected the lease_lost outcome, received %v", outcome)
	}
}

// fail_v1 answers stale after the shutdown cancellation. The reconciliation finds no cancellation,
// and the expiry request then fails. The stale answer already showed a lost lease, so the outcome
// stays lease_lost, as for the same answer to a release after the stop.
func TestAStaleFailureRowAfterTheStopKeepsTheLostLease(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{})
	task := ClaimedTask{
		ID:         "11111111-1111-1111-1111-111111111111",
		Type:       "send-invoice",
		Queue:      "defaults",
		Attempt:    2,
		FenceToken: 7,
	}
	// The expiry request uses the unconnected pool of the worker, so it fails.
	executor := statementExecutor{rows: map[string][]Row{
		failStatementName:              {{rowStateField: workerFailureStale}},
		acknowledgeCancelStatementName: {{rowAcceptedField: false}},
	}}

	outcome, err := worker.failAfterShutdown(context.Background(), executor, task, errors.New("handler failed"))

	if err == nil {
		t.Fatal("expected the failed expiry request")
	}
	if outcome != handlerOutcomeLeaseLost {
		t.Fatalf("expected the lease_lost outcome, received %v", outcome)
	}
}
