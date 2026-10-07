package transactionproof

import (
	"context"
	"errors"
	"fmt"
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
