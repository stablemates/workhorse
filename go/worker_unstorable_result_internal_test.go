package workhorse

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"
)

// completionOutageExecutor refuses every completion the way a lost connection would and records
// every statement and failure envelope the worker sends.
type completionOutageExecutor struct {
	failureRecordingExecutor
	outage error
}

func (executor *completionOutageExecutor) Query(ctx context.Context, statement string, arguments ...any) ([]Row, error) {
	if statement == protocolStatementRegistry[completeStatementName] {
		executor.statements = append(executor.statements, statement)
		return nil, executor.outage
	}
	return executor.failureRecordingExecutor.Query(ctx, statement, arguments...)
}

func claimedResultTask(t *testing.T) ClaimedTask {
	t.Helper()
	task, err := claimedTask(claimRow(map[string]any{}), "defaults")
	if err != nil {
		t.Fatal(err)
	}
	task.claimSentAt = time.Now()
	return task
}

// A result jsonb refuses fails its attempt through fail_v1. The envelope names the task type but
// carries no part of the value, so fail_v1's own jsonb cast accepts it.
func TestAnUnstorableResultFailsItsAttemptWithAStorableEnvelope(t *testing.T) {
	executor := &completionOutageExecutor{outage: errors.New("complete_v1 must not run")}
	worker := newDefaultWorker(t, WorkerOptions{})
	err := worker.execute(context.Background(), executor, claimedResultTask(t), func(context.Context, any, *HandlerContext) (any, error) {
		return map[string]any{"k\x00": "a\x00b"}, nil
	})
	if err != nil {
		t.Fatalf("execute returned %v", err)
	}
	if slices.Contains(executor.statements, protocolStatementRegistry[completeStatementName]) {
		t.Fatal("the unstorable result reached complete_v1")
	}
	if len(executor.envelopes) != 1 || hasUnstorableEscape([]byte(executor.envelopes[0])) {
		t.Fatalf("unexpected failure envelopes %q", executor.envelopes)
	}
}

// Only a value the worker refuses becomes a task failure. A database failure during completion
// still ends the attempt with that error, and the worker sends no fail_v1 for it.
func TestAnOperationalCompletionErrorStillPropagates(t *testing.T) {
	outage := errors.New("connection lost during completion")
	executor := &completionOutageExecutor{outage: outage}
	worker := newDefaultWorker(t, WorkerOptions{})
	err := worker.execute(context.Background(), executor, claimedResultTask(t), func(context.Context, any, *HandlerContext) (any, error) {
		return map[string]any{"ok": true}, nil
	})
	if !errors.Is(err, outage) {
		t.Fatalf("execute returned %v, want the completion outage", err)
	}
	if len(executor.envelopes) != 0 {
		t.Fatalf("the worker failed the task for a database outage: %q", executor.envelopes)
	}
}

// encoding/json escapes <, > and &, so ordinary text carries \u escapes. Only a \u0000 or a \ud or
// \uD escape may send it on to the full scan, and the scan still accepts a valid surrogate pair.
func TestOrdinaryTextSkipsTheUnstorableEscapeScan(t *testing.T) {
	for _, value := range []any{"é<b>&amp;", map[string]any{"ключ": "値 <a href>"}, "\U0001F600"} {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if mayHoldUnstorableEscape(encoded) || hasUnstorableEscape(encoded) {
			t.Errorf("ordinary text %s reached the escape scan", encoded)
		}
	}
	for _, document := range []string{`"\ud83d\ude00"`, `"\uD83D\uDE00"`} {
		if !mayHoldUnstorableEscape([]byte(document)) || hasUnstorableEscape([]byte(document)) {
			t.Errorf("valid surrogate pair %s was not scanned and accepted", document)
		}
	}
	for _, document := range []string{`"\u0000"`, `"\ud800"`, `"\uDC00"`, `"<\u003c\uD83D"`} {
		if !hasUnstorableEscape([]byte(document)) {
			t.Errorf("unstorable escape %s was accepted", document)
		}
	}
}
