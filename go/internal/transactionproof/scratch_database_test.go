package transactionproof

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// scriptedExecutor answers each Exec with the next scripted error and records the statements.
type scriptedExecutor struct {
	errors     []error
	statements []string
}

func (executor *scriptedExecutor) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	executor.statements = append(executor.statements, sql)
	if len(executor.errors) == 0 {
		return pgconn.CommandTag{}, nil
	}
	err := executor.errors[0]
	executor.errors = executor.errors[1:]
	return pgconn.CommandTag{}, err
}

func TestDropScratchDatabaseRetriesWhileInUse(t *testing.T) {
	previousPause := scratchDropPause
	scratchDropPause = time.Millisecond
	t.Cleanup(func() { scratchDropPause = previousPause })
	inUse := &pgconn.PgError{Code: "55006", Message: "database is being accessed by other users"}

	// A foreign session holds the database through the first drop, then exits.
	executor := &scriptedExecutor{errors: []error{nil, inUse, nil, nil}}
	if err := dropScratchDatabase(context.Background(), executor, "scratch"); err != nil {
		t.Fatalf("drop after one in-use attempt: %v", err)
	}
	if len(executor.statements) != 4 {
		t.Fatalf("statements = %d, want terminate and drop twice: %q", len(executor.statements), executor.statements)
	}
	for index, statement := range executor.statements {
		wantTerminate := index%2 == 0
		if wantTerminate && !strings.Contains(statement, "usename = current_user AND pid <> pg_backend_pid()") {
			t.Fatalf("statement %d terminates sessions beyond the test role: %s", index, statement)
		}
		if !wantTerminate && statement != `DROP DATABASE IF EXISTS "scratch"` {
			t.Fatalf("statement %d = %s, want the drop", index, statement)
		}
	}

	// The database stays in use through every attempt.
	held := make([]error, 0, 2*scratchDropAttempts)
	for range scratchDropAttempts {
		held = append(held, nil, inUse)
	}
	executor = &scriptedExecutor{errors: held}
	err := dropScratchDatabase(context.Background(), executor, "scratch")
	if !errors.Is(err, inUse) || len(executor.statements) != 2*scratchDropAttempts {
		t.Fatalf("held drop = %v after %d statements, want the in-use error after %d attempts", err, len(executor.statements), scratchDropAttempts)
	}

	// Any other drop error, and a failed terminate, return at once.
	denied := &pgconn.PgError{Code: "42501", Message: "must be owner of database scratch"}
	executor = &scriptedExecutor{errors: []error{nil, denied}}
	if err := dropScratchDatabase(context.Background(), executor, "scratch"); !errors.Is(err, denied) || len(executor.statements) != 2 {
		t.Fatalf("denied drop = %v after %d statements, want the error after one attempt", err, len(executor.statements))
	}
	terminateFailed := errors.New("connection reset")
	executor = &scriptedExecutor{errors: []error{terminateFailed}}
	if err := dropScratchDatabase(context.Background(), executor, "scratch"); !errors.Is(err, terminateFailed) || len(executor.statements) != 1 {
		t.Fatalf("terminate failure = %v after %d statements, want it returned before the drop", err, len(executor.statements))
	}
}
