package workhorse

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// ServerBoundedQueryForTest exposes the transaction that bounds a heartbeat statement on the
// server to the external test that checks PostgreSQL ends it.
func ServerBoundedQueryForTest(ctx context.Context, conn *pgx.Conn, statement string) ([]Row, error) {
	return serverBoundedExecutor{conn: conn}.Query(ctx, statement)
}
