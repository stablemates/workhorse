package workhorse

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
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
// outcome lease_lost, as on the execution path. Before, they counted canceled. The lost lease ends
// this activation only, so release returns no error and the worker continues, as in TypeScript.
// Before, release returned the lost lease, and the dispatcher stopped the run with it.
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

	if err := worker.release(context.Background(), executor, task); err != nil {
		t.Fatalf("release() = %v, want nil", err)
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

// A task without a handler is released. As on the execution path and in TypeScript, a lost lease,
// such as a refused acknowledgement of a cancel_requested answer, does not give the handler span the
// error status. A failed statement does.
func TestAReleaseMarksOnlyAFailedStatementAsASpanError(t *testing.T) {
	task := ClaimedTask{
		ID:         "11111111-1111-1111-1111-111111111111",
		Type:       "missing",
		Queue:      "defaults",
		Attempt:    1,
		FenceToken: 7,
	}
	releaseFailed := errors.New("release failed")
	for _, test := range []struct {
		name     string
		executor statementExecutor
		outcome  string
		code     codes.Code
	}{
		{
			name: "refused acknowledgement",
			executor: statementExecutor{rows: map[string][]Row{
				releaseOwnedStatementName:      {{rowStatusField: workerFailureCancelRequested}},
				acknowledgeCancelStatementName: {{rowAcceptedField: false}},
			}},
			outcome: "stale",
			code:    codes.Unset,
		},
		{
			name:     "failed statement",
			executor: statementExecutor{errors: map[string]error{releaseOwnedStatementName: releaseFailed}},
			outcome:  "unknown",
			code:     codes.Error,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			exporter := tracetest.NewInMemoryExporter()
			provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
			previousProvider := otel.GetTracerProvider()
			otel.SetTracerProvider(provider)
			t.Cleanup(func() {
				otel.SetTracerProvider(previousProvider)
				_ = provider.Shutdown(context.Background())
			})
			worker := newDefaultWorker(t, WorkerOptions{})

			_ = worker.release(context.Background(), test.executor, task)

			spans := exporter.GetSpans()
			if len(spans) != 1 || spans[0].Name != handlerSpanName {
				t.Fatalf("spans = %v, want one handler span", spans)
			}
			span := spans[0]
			outcome := ""
			for _, attribute := range span.Attributes {
				if string(attribute.Key) == handlerOutcomeAttribute {
					outcome = attribute.Value.AsString()
				}
			}
			if outcome != test.outcome {
				t.Fatalf("span outcome = %q, want %q", outcome, test.outcome)
			}
			exceptions := 0
			for _, event := range span.Events {
				if event.Name == "exception" {
					exceptions++
				}
			}
			wantExceptions := 0
			if test.code == codes.Error {
				wantExceptions = 1
			}
			if span.Status.Code != test.code || exceptions != wantExceptions {
				t.Fatalf("span status = %v with %d exception events, want %v with %d",
					span.Status.Code, exceptions, test.code, wantExceptions)
			}
		})
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

// fail_v1 answers stale. The reconciliation finds no cancellation, and the expiry request then
// fails. As in TypeScript, where reconcileStale rejects, the request settled nothing, so the
// attempt has no outcome and the error ends the run. Before, the Go worker reported lease_lost.
func TestAFailedExpiryRequestOfAReconciliationHasNoOutcome(t *testing.T) {
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
	for _, afterStop := range []bool{false, true} {
		t.Run(fmt.Sprintf("after the stop %v", afterStop), func(t *testing.T) {
			worker := newDefaultWorker(t, WorkerOptions{})
			var outcome handlerOutcome
			var err error
			if afterStop {
				outcome, err = worker.failAfterShutdown(context.Background(), executor, task, errors.New("handler failed"))
			} else {
				outcome, err = worker.failAttempt(context.Background(), executor, task, errors.New("handler failed"))
			}
			if err == nil || errors.Is(err, ErrStaleLease) {
				t.Fatalf("expected the error of the expiry request, received %v", err)
			}
			if outcome != handlerOutcomeUnknown {
				t.Fatalf("expected the unknown outcome, received %v", outcome)
			}
		})
	}
}

// A release after the shutdown cancellation answers cancel_requested, and PostgreSQL then refuses
// the acknowledgement. The worker settled nothing, so the outcome is lease_lost, as for the same
// answer to a failure. Before, it was canceled.
func TestARefusedAcknowledgementOfAShutdownReleaseIsALostLease(t *testing.T) {
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
	executor := statementExecutor{rows: map[string][]Row{
		releaseOwnedStatementName:      {{rowStatusField: workerFailureCancelRequested}},
		acknowledgeCancelStatementName: {{rowAcceptedField: false}},
	}}

	outcome, err := worker.settleAfterShutdown(
		context.Background(), executor, task, nil, nil, errors.New("handler stopped"),
	)

	if !errors.Is(err, ErrStaleLease) {
		t.Fatalf("expected the lost lease, received %v", err)
	}
	if outcome != handlerOutcomeLeaseLost {
		t.Fatalf("expected the lease_lost outcome, received %v", outcome)
	}
}
