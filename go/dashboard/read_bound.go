package dashboard

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
	"github.com/stablemates/workhorse/go/internal/executorqueryer"
)

// DefaultStatementTimeout is how long one dashboard read can run before PostgreSQL cancels it. It
// is the DASHBOARD_STATEMENT_TIMEOUT_MS default of the TypeScript host.
const DefaultStatementTimeout = 15 * time.Second

// queryCanceled is the SQLSTATE of a statement that PostgreSQL cancels for its statement_timeout.
const queryCanceled = "57014"

// setStatementTimeout sets the bound for the rest of the transaction. The value is a bind
// parameter, so it never enters statement text.
const setStatementTimeout = "SELECT set_config('statement_timeout', $1, true)"

// readTimeoutError is the RPC answer for a read that PostgreSQL canceled. The TypeScript router
// answers the same code, status, and message.
func readTimeoutError() *RPCError {
	return &RPCError{Status: http.StatusRequestTimeout, Code: "TIMEOUT", Message: "This read exceeded its time bound"}
}

// boundedReader runs each dashboard read in its own read-only transaction with a
// transaction-local statement_timeout. PostgreSQL arms the statement timer when a statement
// starts, so the bound must be set before the read and not inside it.
//
// The transaction needs one connection for several statements. A pgx pool, a database/sql
// database, or a pgx connection outside a transaction can lend one. A database/sql connection can
// lend one only with the pgx driver, which reports its transaction state. A caller-owned transaction cannot: a
// raw BEGIN there starts no new transaction, so the COMMIT of the read would commit the caller's
// work, and a local setting would stay in the caller's transaction. So a read through a caller
// transaction, through a connection inside one, or through an Executor that this module did not
// make, runs directly and with no bound. On a single connection the handler runs one procedure at
// a time (singleConnection), so a statement of another request cannot run inside the read.
type boundedReader struct {
	executor workhorse.Executor
	timeout  string
}

type pgxBeginner interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}

type sqlBeginner interface {
	BeginTx(context.Context, *sql.TxOptions) (*sql.Tx, error)
}

func newBoundedReader(executor workhorse.Executor, timeout time.Duration) *boundedReader {
	return &boundedReader{executor: executor, timeout: strconv.FormatInt(timeout.Milliseconds(), 10)}
}

func (reader *boundedReader) Query(ctx context.Context, statement string, arguments ...any) ([]workhorse.Row, error) {
	rows, err := reader.query(ctx, statement, arguments)
	if hasSQLState(err, queryCanceled) {
		return nil, readTimeoutError()
	}
	return rows, err
}

func (reader *boundedReader) query(ctx context.Context, statement string, arguments []any) ([]workhorse.Row, error) {
	queryer, _ := executorqueryer.Of(reader.executor)
	// Only a type whose transaction state is known opens a transaction of its own. A caller type
	// that wraps or embeds a connection can hold a caller transaction that this read cannot see,
	// so it reads directly.
	switch queryer := queryer.(type) {
	case *pgxpool.Pool:
		// The read holds its pool connection here, so the connection returns on each path. A tracer
		// of the caller can panic inside BEGIN, before a transaction exists to roll back.
		conn, err := queryer.Acquire(ctx)
		if err != nil {
			return nil, err
		}
		defer conn.Release()
		return reader.pgxRead(ctx, conn, statement, arguments)
	case *pgxpool.Conn:
		if queryer.Conn().PgConn().TxStatus() == 'I' {
			return reader.pgxRead(ctx, queryer, statement, arguments)
		}
	case *pgx.Conn:
		if queryer.PgConn().TxStatus() == 'I' {
			return reader.pgxRead(ctx, queryer, statement, arguments)
		}
	case *sql.DB:
		return reader.sqlRead(ctx, queryer, statement, arguments)
	case *sql.Conn:
		if idleSQLConn(queryer) {
			return reader.sqlRead(ctx, queryer, statement, arguments)
		}
	}
	return reader.executor.Query(ctx, statement, arguments...)
}

func (reader *boundedReader) pgxRead(ctx context.Context, conn pgxBeginner, statement string, arguments []any) ([]workhorse.Row, error) {
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	// Rollback after a commit does nothing. After a failure it ends the transaction, so the
	// connection goes back clean.
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	return boundedRows(ctx, workhorse.NewPGXExecutor(tx), reader.timeout, statement, arguments, func() error { return tx.Commit(ctx) })
}

func (reader *boundedReader) sqlRead(ctx context.Context, conn sqlBeginner, statement string, arguments []any) ([]workhorse.Row, error) {
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	return boundedRows(ctx, workhorse.NewSQLExecutor(tx), reader.timeout, statement, arguments, tx.Commit)
}

// idleSQLConn reports whether a database/sql connection is outside a transaction. A BEGIN on a
// connection inside a caller transaction does not start a new transaction, so the COMMIT of the
// read would commit the caller's work. Only the pgx driver reports this state, so a connection of
// another driver is not idle and reads with no bound.
func idleSQLConn(conn *sql.Conn) bool {
	known := false
	err := conn.Raw(func(driverConn any) error {
		if pgxConn, ok := driverConn.(interface{ Conn() *pgx.Conn }); ok {
			known = pgxConn.Conn().PgConn().TxStatus() == 'I'
		}
		return nil
	})
	return err == nil && known
}

// singleConnection reports whether an Executor of this module wraps one connection, which
// concurrent requests would share.
func singleConnection(executor workhorse.Executor) bool {
	queryer, _ := executorqueryer.Of(executor)
	switch queryer.(type) {
	case *pgx.Conn, *pgxpool.Conn, *sql.Conn:
		return true
	default:
		return false
	}
}

func boundedRows(ctx context.Context, tx workhorse.Executor, timeout, statement string, arguments []any, commit func() error) ([]workhorse.Row, error) {
	if _, err := tx.Query(ctx, setStatementTimeout, timeout); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, statement, arguments...)
	if err != nil {
		return nil, err
	}
	if err := commit(); err != nil {
		return nil, err
	}
	return rows, nil
}

func hasSQLState(err error, state string) bool {
	var carrier interface{ SQLState() string }
	return errors.As(err, &carrier) && carrier.SQLState() == state
}
