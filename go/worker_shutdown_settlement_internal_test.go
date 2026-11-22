package workhorse

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// A release after the shutdown cancellation fails, as in a short database outage. The worker logs
// the catalogued event that the TypeScript and Python workers log, returns the error for Run, and
// lease recovery settles the task.
func TestWorkerLogsTheShutdownSettlementFailedEvent(t *testing.T) {
	var output bytes.Buffer
	worker := &Worker{
		workerID: "shutdown-worker",
		logger:   slog.New(slog.NewTextHandler(&output, nil)),
	}
	task := ClaimedTask{
		ID:         "11111111-1111-1111-1111-111111111111",
		Type:       "send-invoice",
		Queue:      "billing",
		Attempt:    2,
		FenceToken: 7,
	}

	outcome, err := worker.settleAfterShutdown(
		context.Background(),
		failingRegistryExecutor{},
		task,
		nil,
		nil,
		errors.New("handler stopped"),
	)

	// The release settled nothing, so the attempt has no outcome, as in TypeScript. The handler
	// metrics then count no execution.
	if outcome != handlerOutcomeUnknown {
		t.Fatalf("expected the unknown outcome, received %v", outcome)
	}
	// SM-2073: Run returns this error, as Ruby, Rust, the JVM, and .NET do.
	if err == nil || err.Error() != "registry is offline" {
		t.Fatalf("expected the release error, received %v", err)
	}
	logged := output.String()
	for _, field := range []string{
		"level=WARN",
		`msg="Worker could not settle a task after the shutdown abort"`,
		"event.name=workhorse.worker.shutdown_settlement_failed",
		"workhorse.task.id=" + task.ID,
		"workhorse.queue.name=billing",
		"workhorse.worker.id=shutdown-worker",
		"error.type=*errors.errorString",
	} {
		if !strings.Contains(logged, field) {
			t.Fatalf("expected %s in the warning:\n%s", field, logged)
		}
	}
	// docs/architecture/telemetry.md, "Log content limits": a record never holds the error message.
	if strings.Contains(logged, "registry is offline") {
		t.Fatalf("the warning holds the error message:\n%s", logged)
	}
}

// A failure write after the shutdown cancellation fails. The attempt settled nothing, so it has no
// outcome, and the handler metrics count no execution.
func TestAFailedFailureWriteAfterTheStopHasNoOutcome(t *testing.T) {
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

	outcome, err := worker.failAfterShutdown(context.Background(), failingRegistryExecutor{}, task, errors.New("handler failed"))

	if err == nil {
		t.Fatal("expected the failure write error")
	}
	if outcome != handlerOutcomeUnknown {
		t.Fatalf("expected the unknown outcome, received %v", outcome)
	}
}

// SM-2073: a panic in execute outside the handler, such as in the Error method of a handler error,
// after the stop. failPanickedExecution writes the failure; when that write fails, Run must see
// the error instead of the stop's cancellation.
func TestFailPanickedExecutionReturnsAFailedWriteAfterTheStop(t *testing.T) {
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
	stopped, stop := context.WithCancel(context.Background())
	stop()

	_, err := worker.failPanickedExecution(stopped, failingRegistryExecutor{}, task, "defect")

	if err == nil || errors.Is(err, context.Canceled) {
		t.Fatalf("expected the failed write, received %v", err)
	}
}

// cancelledFailureExecutor fails the failure write with a cancellation, as a driver can report it,
// and records whether that write ran on a live context.
type cancelledFailureExecutor struct{ sawLiveWrite bool }

func (executor *cancelledFailureExecutor) Query(ctx context.Context, sql string, _ ...any) ([]Row, error) {
	if sql == protocolStatementRegistry[failStatementName] {
		executor.sawLiveWrite = ctx.Err() == nil
		return nil, fmt.Errorf("failure write canceled: %w", context.Canceled)
	}
	return nil, fmt.Errorf("unexpected statement: %s", sql)
}

// SM-2073: the stop cancels the execution while RetryDelay runs, so failAttempt sends fail_v1 on the
// unwind window. That write fails with a cancellation. The drain must keep the error, or Run would
// report a clean stop.
func TestFailureWriteDetachedByTheStopReachesTheDrain(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	worker := newDefaultWorker(t, WorkerOptions{
		RetryDelay: func(int, ClaimedTask) *time.Duration {
			cancel()
			return nil
		},
	})
	var output bytes.Buffer
	worker.logger = slog.New(slog.NewTextHandler(&output, nil))
	executor := &cancelledFailureExecutor{}

	err := worker.execute(ctx, executor, claimedResultTask(t), func(
		context.Context, any, *HandlerContext,
	) (any, error) {
		return nil, errors.New("handler failure before the cancellation")
	})

	if !executor.sawLiveWrite {
		t.Fatal("the failure write did not run on the unwind window")
	}
	results := make(chan executionResult, 1)
	results <- executionResult{err: err}
	if _, drained := worker.drainExecutions(ctx, results, 1, nil, func() {}); drained == nil {
		t.Fatalf("execute returned %T %v, and the drain dropped it", err, err)
	}
	// The failed write is logged as every other settlement failure after the stop is.
	if !strings.Contains(output.String(), "event.name=workhorse.worker.shutdown_settlement_failed") {
		t.Fatalf("expected the shutdown settlement failure event:\n%s", output.String())
	}
}

// detachedSettlementExecutor answers the failure write and the cancellation acknowledgement that
// failAttempt sends on the unwind window. Each statement must run on a live context.
type detachedSettlementExecutor struct {
	state       string
	failError   error
	ackError    error
	ackAccepted bool
}

func (executor detachedSettlementExecutor) Query(ctx context.Context, sql string, _ ...any) ([]Row, error) {
	if ctx.Err() != nil {
		return nil, fmt.Errorf("expected the live unwind context: %w", ctx.Err())
	}
	switch sql {
	case protocolStatementRegistry[failStatementName]:
		if executor.failError != nil {
			return nil, executor.failError
		}
		return []Row{{rowStateField: executor.state}}, nil
	case protocolStatementRegistry[acknowledgeCancelStatementName]:
		if executor.ackError != nil {
			return nil, executor.ackError
		}
		return []Row{{rowAcceptedField: executor.ackAccepted}}, nil
	}
	return nil, fmt.Errorf("unexpected statement: %s", sql)
}

// SM-2073: each write that failAttempt sends after the stop moved it into the unwind window reaches
// the drain when it fails with a cancellation, and a success or a lost lease ends no run.
func TestDetachedFailureSettlementPaths(t *testing.T) {
	cancelled := fmt.Errorf("driver: %w", context.Canceled)
	for _, test := range []struct {
		name     string
		executor detachedSettlementExecutor
		keeps    bool
	}{
		{"failure write", detachedSettlementExecutor{failError: cancelled}, true},
		{"acknowledgement", detachedSettlementExecutor{state: workerFailureCancelRequested, ackError: cancelled}, true},
		{"reconciliation", detachedSettlementExecutor{state: workerFailureStale, ackError: cancelled}, true},
		{"success", detachedSettlementExecutor{state: workerFailureFailed}, false},
		{"lost lease", detachedSettlementExecutor{state: workerFailureCancelRequested}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			worker := newDefaultWorker(t, WorkerOptions{
				RetryDelay: func(int, ClaimedTask) *time.Duration {
					cancel()
					return nil
				},
			})

			err := worker.execute(ctx, test.executor, claimedResultTask(t), func(
				context.Context, any, *HandlerContext,
			) (any, error) {
				return nil, errors.New("handler failure before the cancellation")
			})

			results := make(chan executionResult, 1)
			results <- executionResult{err: err}
			_, drained := worker.drainExecutions(ctx, results, 1, nil, func() {})
			if test.keeps && drained == nil {
				t.Fatalf("execute returned %T %v, and the drain dropped it", err, err)
			}
			if !test.keeps && err != nil {
				t.Fatalf("expected no error of the run, received %v", err)
			}
		})
	}
}

// SM-2073: the acknowledgement after the stop finds the lease lost. The handler outcome stays
// lease_lost, as it is without the stop, and the run does not fail.
func TestDetachedAcknowledgementKeepsTheLostLeaseOutcome(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var output bytes.Buffer
	worker := newDefaultWorker(t, WorkerOptions{
		RetryDelay: func(int, ClaimedTask) *time.Duration {
			cancel()
			return nil
		},
	})
	worker.logger = slog.New(slog.NewTextHandler(&output, nil))

	err := worker.execute(ctx, detachedSettlementExecutor{state: workerFailureCancelRequested},
		claimedResultTask(t), func(context.Context, any, *HandlerContext) (any, error) {
			return nil, errors.New("handler failure before the cancellation")
		})

	if err != nil {
		t.Fatalf("a lost lease must not fail Run: %v", err)
	}
	if !strings.Contains(output.String(), "workhorse.handler.outcome=lease_lost") {
		t.Fatalf("expected the lease_lost outcome:\n%s", output.String())
	}
	if strings.Contains(output.String(), "workhorse.worker.shutdown_settlement_failed") {
		t.Fatalf("a lost lease is not a failed settlement:\n%s", output.String())
	}
}

// SM-2073: failAfterShutdown writes a failure, and a slow RetryDelay outlives its unwind window, so
// failAttempt opens a new one. The failed write is still logged once.
func TestFailAfterShutdownLogsAFailedWriteOnce(t *testing.T) {
	var output bytes.Buffer
	worker := newDefaultWorker(t, WorkerOptions{
		RetryDelay: func(int, ClaimedTask) *time.Duration {
			// Two windows, so failAfterShutdown's window has expired when failAttempt checks it.
			time.Sleep(2 * handlerUnwindPeriod)
			return nil
		},
	})
	worker.logger = slog.New(slog.NewTextHandler(&output, nil))

	_, err := worker.failAfterShutdown(context.Background(),
		detachedSettlementExecutor{failError: errors.New("failure write failed")},
		claimedResultTask(t), errors.New("handler failure"))

	// The executor refuses an expired context, so this error proves the fresh window was used.
	if err == nil || err.Error() != "failure write failed" {
		t.Fatalf("expected the failed write on a fresh window, received %v", err)
	}
	if logged := strings.Count(output.String(), "event.name=workhorse.worker.shutdown_settlement_failed"); logged != 1 {
		t.Fatalf("expected one shutdown settlement failure event, received %d:\n%s", logged, output.String())
	}
}
