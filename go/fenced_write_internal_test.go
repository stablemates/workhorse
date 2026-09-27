package workhorse

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// scriptedExecutor fails with each scripted error in turn and then answers with row.
type scriptedExecutor struct {
	failures []error
	row      Row
	sent     []string
}

func (executor *scriptedExecutor) Query(_ context.Context, statement string, _ ...any) ([]Row, error) {
	executor.sent = append(executor.sent, statement)
	if len(executor.sent) <= len(executor.failures) {
		return nil, executor.failures[len(executor.sent)-1]
	}
	return []Row{executor.row}, nil
}

func sqlStateError(code string) error {
	return &pgconn.PgError{Code: code, Message: code}
}

// A settlement whose dependency cascade crossed another one is sent again, and the fence decides
// again whether it still holds.
func TestFencedWriteRetriesADeadlockVictim(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{})
	executor := &scriptedExecutor{
		failures: []error{sqlStateError(deadlockDetectedSQLState), sqlStateError(deadlockDetectedSQLState)},
		row:      Row{rowAcceptedField: true},
	}
	task := ClaimedTask{ID: "task", Queue: "defaults", FenceToken: 1}
	accepted, err := worker.writeCompletion(context.Background(), executor, task, []byte(`null`))
	if err != nil || !accepted {
		t.Fatalf("writeCompletion answered %v, %v", accepted, err)
	}
	if len(executor.sent) != fencedWriteDeadlockAttempts {
		t.Fatalf("sent complete_v1 %d times", len(executor.sent))
	}
	for _, statement := range executor.sent {
		if !strings.Contains(statement, "workhorse.complete_v1(") {
			t.Fatalf("sent %q", statement)
		}
	}
}

func TestFencedWriteReturnsTheLastDeadlockAfterEveryAttempt(t *testing.T) {
	deadlocks := []error{
		sqlStateError(deadlockDetectedSQLState),
		sqlStateError(deadlockDetectedSQLState),
		sqlStateError(deadlockDetectedSQLState),
	}
	executor := &scriptedExecutor{failures: deadlocks}
	_, err := queryFencedWrite(context.Background(), executor, "statement")
	if !errors.Is(err, deadlocks[2]) || len(executor.sent) != fencedWriteDeadlockAttempts {
		t.Fatalf("answered %v after %d sends", err, len(executor.sent))
	}
}

// In a caller-owned transaction the deadlock aborted the transaction, so the resend fails with
// 25P02. The caller learns about the deadlock, not about the aborted transaction.
func TestFencedWriteReturnsTheDeadlockThatAbortedACallerTransaction(t *testing.T) {
	deadlock := sqlStateError(deadlockDetectedSQLState)
	executor := &scriptedExecutor{failures: []error{deadlock, sqlStateError(inFailedSQLTransactionSQLState)}}
	_, err := queryFencedWrite(context.Background(), executor, "statement")
	if !errors.Is(err, deadlock) || len(executor.sent) != 2 {
		t.Fatalf("answered %v after %d sends", err, len(executor.sent))
	}
}

func TestFencedWriteSendsOtherFailuresOnce(t *testing.T) {
	for _, failure := range []error{sqlStateError("40001"), sqlStateError(inFailedSQLTransactionSQLState)} {
		executor := &scriptedExecutor{failures: []error{failure}}
		_, err := queryFencedWrite(context.Background(), executor, "statement")
		if !errors.Is(err, failure) || len(executor.sent) != 1 {
			t.Fatalf("answered %v after %d sends", err, len(executor.sent))
		}
	}
}
