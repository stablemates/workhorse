package workhorse_test

import (
	"context"
	"database/sql"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	workhorse "github.com/stablemates/workhorse/go"
)

var (
	_ workhorse.PGXQueryer = (pgx.Tx)(nil)
	_ workhorse.PGXQueryer = (*pgx.Conn)(nil)
	_ workhorse.PGXQueryer = (*pgxpool.Pool)(nil)
	_ workhorse.SQLQueryer = (*sql.Tx)(nil)
	_ workhorse.SQLQueryer = (*sql.Conn)(nil)
	_ workhorse.SQLQueryer = (*sql.DB)(nil)
)

func TestPGXAdaptersReturnRowsAndLeaveOwnershipWithCaller(t *testing.T) {
	databaseURL := testDatabaseURL(t)
	ctx := context.Background()

	connection, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close(ctx) })
	assertQuery(t, workhorse.NewPGXExecutor(connection))

	transaction, err := connection.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = transaction.Rollback(ctx) })
	assertQuery(t, workhorse.NewPGXExecutor(transaction))
	assertQuery(t, workhorse.NewPGXExecutor(transaction))

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	assertQuery(t, workhorse.NewPGXExecutor(pool))
}

func TestDatabaseSQLAdaptersReturnRowsAndLeaveOwnershipWithCaller(t *testing.T) {
	databaseURL := testDatabaseURL(t)
	ctx := context.Background()

	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	assertQuery(t, workhorse.NewSQLExecutor(database))

	connection, err := database.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	assertQuery(t, workhorse.NewSQLExecutor(connection))

	transaction, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = transaction.Rollback() })
	assertQuery(t, workhorse.NewSQLExecutor(transaction))
	assertQuery(t, workhorse.NewSQLExecutor(transaction))
}

func assertQuery(t *testing.T, executor workhorse.Executor) {
	t.Helper()

	rows, err := executor.Query(context.Background(), "SELECT $1::text AS value", "from-workhorse")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0]["value"] != "from-workhorse" {
		t.Fatalf("unexpected rows: %#v", rows)
	}
}

func testDatabaseURL(t *testing.T) string {
	t.Helper()

	databaseURL := os.Getenv("WORKHORSE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("WORKHORSE_TEST_DATABASE_URL is required for integration tests")
	}
	return databaseURL
}
