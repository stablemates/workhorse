package dashboard

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Drop attempts before dropScratchDatabase gives up. PostgreSQL waits a few seconds inside each
// attempt for other sessions to exit, so the bound is a count rather than a deadline.
const scratchDropAttempts = 10

// Pause between drop attempts. Tests of the retry path shorten it.
var scratchDropPause = 100 * time.Millisecond

// scratchExecutor is the part of *pgx.Conn that dropScratchDatabase uses.
type scratchExecutor interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

// dropScratchDatabase drops name without WITH (FORCE), which would signal sessions of roles the
// test role may not signal, such as autovacuum. It terminates only the test role's own sessions,
// then retries while foreign sessions still hold the database (SQLSTATE 55006).
func dropScratchDatabase(ctx context.Context, admin scratchExecutor, name string) error {
	statement := "DROP DATABASE IF EXISTS " + pgx.Identifier{name}.Sanitize()
	for attempt := 1; ; attempt++ {
		if _, err := admin.Exec(ctx,
			"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND usename = current_user AND pid <> pg_backend_pid()",
			name,
		); err != nil {
			return fmt.Errorf("terminate sessions on %s: %w", name, err)
		}
		_, err := admin.Exec(ctx, statement)
		var databaseError *pgconn.PgError
		if err == nil || !errors.As(err, &databaseError) || databaseError.Code != "55006" {
			return err
		}
		if attempt >= scratchDropAttempts {
			return fmt.Errorf("other sessions kept %s in use through %d attempts: %w", name, attempt, err)
		}
		time.Sleep(scratchDropPause)
	}
}

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
