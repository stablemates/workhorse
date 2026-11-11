package workhorse

import (
	"context"
	"database/sql"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stablemates/workhorse/go/internal/executorqueryer"
)

func init() { executorqueryer.Of = driverQueryer }

// driverQueryer returns the driver value of an Executor that NewPGXExecutor or NewSQLExecutor made.
func driverQueryer(executor any) (any, bool) {
	switch executor := executor.(type) {
	case *pgxExecutor:
		return executor.queryer, true
	case *sqlExecutor:
		return executor.queryer, true
	default:
		return nil, false
	}
}

// Row is one result row keyed by its PostgreSQL column name.
type Row map[string]any

// Executor runs SQL with PostgreSQL positional parameters and returns all result rows.
type Executor interface {
	Query(ctx context.Context, statement string, arguments ...any) ([]Row, error)
}

// PGXQueryer is implemented by pgx.Tx, *pgx.Conn, and *pgxpool.Pool.
type PGXQueryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// SQLQueryer is implemented by *sql.Tx, *sql.Conn, and *sql.DB.
type SQLQueryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

type pgxExecutor struct {
	queryer PGXQueryer
}

// NewPGXExecutor adapts a caller-owned pgx transaction, connection, or pool.
func NewPGXExecutor(queryer PGXQueryer) Executor {
	return &pgxExecutor{queryer: queryer}
}

func (executor *pgxExecutor) Query(
	ctx context.Context,
	statement string,
	arguments ...any,
) ([]Row, error) {
	queryer := executor.queryer
	if pool, ok := queryer.(*pgxpool.Pool); ok {
		// The query takes its pool connection here, so the connection returns on each path. A
		// tracer of the caller can panic inside the query, before pgx returns rows to close, and
		// the worker recovers that panic.
		conn, err := pool.Acquire(ctx)
		if err != nil {
			return nil, err
		}
		defer conn.Release()
		queryer = conn
	}
	rows, err := queryer.Query(ctx, statement, arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	fields := rows.FieldDescriptions()
	result := make([]Row, 0)
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return nil, err
		}
		row := make(Row, len(values))
		for index, value := range values {
			row[fields[index].Name] = value
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

type sqlExecutor struct {
	queryer SQLQueryer
}

// NewSQLExecutor adapts a caller-owned database/sql transaction, connection, or database.
func NewSQLExecutor(queryer SQLQueryer) Executor {
	return &sqlExecutor{queryer: queryer}
}

func (executor *sqlExecutor) Query(
	ctx context.Context,
	statement string,
	arguments ...any,
) (result []Row, err error) {
	rows, err := executor.queryer.QueryContext(ctx, statement, arguments...)
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := rows.Close(); err == nil && closeErr != nil {
			err = closeErr
		}
	}()

	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	result = make([]Row, 0)
	for rows.Next() {
		values := make([]any, len(columns))
		destinations := make([]any, len(columns))
		for index := range values {
			destinations[index] = &values[index]
		}
		if err := rows.Scan(destinations...); err != nil {
			return nil, err
		}
		row := make(Row, len(columns))
		for index, column := range columns {
			row[column] = values[index]
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
