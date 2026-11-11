package dashboard

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	workhorse "github.com/stablemates/workhorse/go"
	"github.com/stablemates/workhorse/go/internal/testdatabase"
)

// A read on a connection inside a caller transaction must not commit that transaction. A BEGIN
// there starts no new transaction, so the read runs in the caller's transaction with no bound.
func TestAReadOnAConnectionInsideACallerTransactionLeavesTheTransactionOpen(t *testing.T) {
	ctx := context.Background()
	databaseURL := createDashboardConformanceDatabase(t, testdatabase.SourceURL(t))
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, "CREATE TABLE caller_transaction_marker (id integer)"); err != nil {
		t.Fatal(err)
	}
	t.Run("pgx connection", func(t *testing.T) {
		conn, err := pgx.Connect(ctx, databaseURL)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close(context.Background()) })
		assertReadLeavesCallerTransactionOpen(t, workhorse.NewPGXExecutor(conn), conn)
	})
	t.Run("acquired pool connection", func(t *testing.T) {
		acquired, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(acquired.Release)
		assertReadLeavesCallerTransactionOpen(t, workhorse.NewPGXExecutor(acquired), acquired.Conn())
	})
}

func assertReadLeavesCallerTransactionOpen(t *testing.T, executor workhorse.Executor, conn *pgx.Conn) {
	t.Helper()
	ctx := context.Background()
	host, err := NewHandler(HandlerOptions{
		Executor:         executor,
		Authorize:        func(*http.Request) Authorization { return Authorization{Principal: &Principal{Actor: "operator"}} },
		StatementTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, "INSERT INTO caller_transaction_marker VALUES (1)"); err != nil {
		t.Fatal(err)
	}

	response := httptest.NewRecorder()
	host.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "https://example.test/workhorse/rpc/dashboard/queues", strings.NewReader(`{"json":null}`)))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	if status := conn.PgConn().TxStatus(); status != 'T' {
		t.Fatalf("transaction status after the read = %c, want T", status)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := conn.QueryRow(ctx, "SELECT count(*) FROM caller_transaction_marker").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("the read committed the caller's insert: %d rows after the rollback", count)
	}
}

type panicOnBegin struct{}

func (panicOnBegin) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.HasPrefix(strings.ToLower(data.SQL), "begin") {
		panic("tracer panic on begin")
	}
	return ctx
}

func (panicOnBegin) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// A tracer of the caller can panic inside BEGIN. The read must still give its pool connection back.
func TestAReadReturnsItsPoolConnectionAfterATracerPanicInBegin(t *testing.T) {
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(createDashboardConformanceDatabase(t, testdatabase.SourceURL(t)))
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	config.ConnConfig.Tracer = panicOnBegin{}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	reader := newBoundedReader(workhorse.NewPGXExecutor(pool), time.Second)
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("the tracer did not panic")
			}
		}()
		_, _ = reader.Query(ctx, "SELECT 1 AS result")
	}()
	if acquired := pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("the read kept %d pool connections after the panic", acquired)
	}
}

// On one database/sql connection, a control waits for a read that runs. Without the lock it would
// run inside the read-only transaction of the read and fail.
func TestAControlOnOneConnectionWaitsForTheReadTransaction(t *testing.T) {
	ctx := context.Background()
	databaseURL := createDashboardConformanceDatabase(t, testdatabase.SourceURL(t))
	observer, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(observer.Close)
	if _, err := observer.Exec(ctx, `DO $do$ BEGIN
  ALTER FUNCTION workhorse.dashboard_events_v1(jsonb) RENAME TO dashboard_events_v1_before_slow_read;
  CREATE FUNCTION workhorse.dashboard_events_v1(p_input jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
  BEGIN PERFORM pg_sleep(1); RETURN workhorse.dashboard_events_v1_before_slow_read(p_input); END $fn$;
END $do$`); err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	conn, err := database.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	host, err := NewHandler(HandlerOptions{
		Executor:         workhorse.NewSQLExecutor(conn),
		Authorize:        func(*http.Request) Authorization { return Authorization{Principal: &Principal{Actor: "operator"}} },
		StatementTimeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	post := func(procedure, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "https://example.test/workhorse/rpc/dashboard/"+procedure, strings.NewReader(body))
		request.Header.Set("Origin", "https://example.test")
		response := httptest.NewRecorder()
		host.ServeHTTP(response, request)
		return response
	}
	if response := post("meta", `{"json":null}`); response.Code != http.StatusOK {
		t.Fatalf("meta = %d: %s", response.Code, response.Body.String())
	}

	read := make(chan *httptest.ResponseRecorder, 1)
	go func() { read <- post("events", `{"json":{"window":"1h"}}`) }()
	// Wait on database state, from a connection of its own, until the read sleeps in PostgreSQL.
	deadline := time.Now().Add(10 * time.Second)
	for {
		var sleeping bool
		if err := observer.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event = 'PgSleep')`).Scan(&sleeping); err != nil {
			t.Fatal(err)
		}
		if sleeping {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the read did not start")
		}
		time.Sleep(5 * time.Millisecond)
	}
	control := post("setQueuePaused", `{"json":{"queue":"one-connection","paused":true,"audit":{"actor":"operator","reason":"test","requestId":"request-1"}}}`)
	if control.Code != http.StatusOK {
		t.Fatalf("control = %d: %s", control.Code, control.Body.String())
	}
	if response := <-read; response.Code != http.StatusOK {
		t.Fatalf("read = %d: %s", response.Code, response.Body.String())
	}
}

// wrappedConn is a caller type that embeds a database/sql connection, so it inherits BeginTx.
type wrappedConn struct{ *sql.Conn }

// The host cannot see the transaction state of a type that it does not know, so the read takes
// the direct path and leaves the caller's transaction and its pending write as they were.
func TestAReadThroughAWrapperOfAConnectionInsideACallerTransactionCommitsNothing(t *testing.T) {
	ctx := context.Background()
	databaseURL := createDashboardConformanceDatabase(t, testdatabase.SourceURL(t))
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	conn, err := database.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	host, err := NewHandler(HandlerOptions{
		Executor:         workhorse.NewSQLExecutor(wrappedConn{conn}),
		Authorize:        func(*http.Request) Authorization { return Authorization{Principal: &Principal{Actor: "operator"}} },
		StatementTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{"CREATE TABLE wrapped_marker (id integer)", "BEGIN", "INSERT INTO wrapped_marker VALUES (1)"} {
		if _, err := conn.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}

	response := httptest.NewRecorder()
	host.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "https://example.test/workhorse/rpc/dashboard/queues", strings.NewReader(`{"json":null}`)))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
	// The caller's transaction is still open and read-write, with its insert.
	if _, err := conn.ExecContext(ctx, "INSERT INTO wrapped_marker VALUES (2)"); err != nil {
		t.Fatalf("the read changed the caller's transaction: %v", err)
	}
	var pending int
	if err := conn.QueryRowContext(ctx, "SELECT count(*) FROM wrapped_marker").Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 2 {
		t.Fatalf("rows inside the caller's transaction = %d, want 2", pending)
	}
	if _, err := conn.ExecContext(ctx, "ROLLBACK"); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := conn.QueryRowContext(ctx, "SELECT count(*) FROM wrapped_marker").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("the read committed the caller's insert: %d rows after the rollback", count)
	}
}
