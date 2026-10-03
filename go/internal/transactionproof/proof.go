package transactionproof

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

type Identity struct {
	PID int32
	XID string
}

type Order struct {
	ID       string
	Details  []byte
	Note     *string
	Identity Identity
}

type Transaction struct {
	Executor workhorse.Executor
	Write    func(context.Context, string, string) (string, error)
	Read     func(context.Context, string) (Order, error)
	Identity func(context.Context) (Identity, error)
	Commit   func() error
	Rollback func() error
}

type Fixture struct {
	Begin       func(context.Context) (Transaction, error)
	Create      func(context.Context, string, string) (string, error)
	Observer    *pgxpool.Pool
	Trace       *Trace
	DatabaseURL string
	CLIOrderID  string
}

type observation struct {
	PID       uint32
	Statement string
}

type Trace struct {
	mutex   sync.Mutex
	queries []observation
	errors  []error
}

func (trace *Trace) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	trace.mutex.Lock()
	defer trace.mutex.Unlock()
	trace.queries = append(trace.queries, observation{PID: connection.PgConn().PID(), Statement: data.SQL})
	return ctx
}

func (trace *Trace) TraceQueryEnd(_ context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if data.Err != nil {
		trace.mutex.Lock()
		defer trace.mutex.Unlock()
		trace.errors = append(trace.errors, data.Err)
	}
}

func (trace *Trace) HasSQLState(code string) bool {
	trace.mutex.Lock()
	defer trace.mutex.Unlock()
	for _, err := range trace.errors {
		var pgError *pgconn.PgError
		if errors.As(err, &pgError) && pgError.Code == code {
			return true
		}
	}
	return false
}

func (trace *Trace) Reset() {
	trace.mutex.Lock()
	defer trace.mutex.Unlock()
	trace.queries = nil
	trace.errors = nil
}

func (trace *Trace) AssertBorrowed(t *testing.T, expectedPID int32) {
	t.Helper()
	trace.mutex.Lock()
	defer trace.mutex.Unlock()
	var business, enqueue bool
	for _, query := range trace.queries {
		if query.PID != uint32(expectedPID) {
			t.Fatalf("query escaped connection %d: %+v", expectedPID, query)
		}
		statement := strings.ToLower(strings.TrimSpace(query.Statement))
		if statement == "begin" || strings.HasPrefix(statement, "commit") || strings.HasPrefix(statement, "rollback") {
			t.Fatalf("borrowed executor took over transaction lifecycle: %s", query.Statement)
		}
		business = business || strings.Contains(statement, "insert into recipe_order")
		enqueue = enqueue || strings.Contains(statement, "workhorse.enqueue_many_v1")
	}
	if !business || !enqueue {
		t.Fatalf("trace must include real business and enqueue calls: %+v", trace.queries)
	}
}

func Database(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("real PostgreSQL transaction proof")
	}
	sourceURL := os.Getenv("DATABASE_URL_TEST")
	if sourceURL == "" {
		if os.Getenv("WORKHORSE_REQUIRE_DATABASE") == "1" {
			t.Fatal("DATABASE_URL_TEST is required")
		}
		t.Skip("DATABASE_URL_TEST is required")
	}
	parsed, err := url.Parse(sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	host := parsed.Hostname()
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		t.Fatalf("recipe fixtures refuse non-loopback host %q", host)
	}
	sourceName := strings.TrimPrefix(parsed.Path, "/")
	if !strings.Contains(sourceName, "test") {
		t.Fatal("DATABASE_URL_TEST must name a test database")
	}
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(t.Name()+strconv.Itoa(os.Getpid()))))[:10]
	prefix := sourceName
	if len(prefix) > 44 {
		prefix = prefix[:44]
	}
	databaseName := prefix + "_gr_" + digest
	adminURL := *parsed
	adminURL.Path = "/postgres"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	quotedName := pgx.Identifier{databaseName}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quotedName); err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
	}
	_ = admin.Close(ctx)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		admin, err := pgx.Connect(ctx, adminURL.String())
		if err != nil {
			t.Errorf("connect for scratch cleanup: %v", err)
			return
		}
		defer func() { _ = admin.Close(ctx) }()
		if _, err := admin.Exec(ctx, "DROP DATABASE "+quotedName); err != nil {
			t.Errorf("drop scratch database: %v", err)
		}
	})
	parsed.Path = "/" + databaseName
	connection, err := pgx.Connect(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = connection.Close(ctx) }()
	for _, filename := range []string{
		filepath.Join("..", "..", "..", "sql", "schema", "current.sql"),
		filepath.Join("..", "sqlc", "schema.sql"),
	} {
		contents, err := os.ReadFile(filename)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := connection.Exec(ctx, string(contents)); err != nil {
			t.Fatal(err)
		}
	}
	var version string
	if err := connection.QueryRow(ctx, "SHOW server_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	t.Logf("PostgreSQL %s; isolated database %s", version, databaseName)
	return parsed.String()
}

func Run(t *testing.T, fixture Fixture) {
	t.Helper()
	ctx := context.Background()
	nextID := 0
	newID := func() string {
		nextID++
		return fmt.Sprintf("%08x-aaaa-4aaa-8aaa-aaaaaaaaaaaa", nextID)
	}
	begin := func(t *testing.T) Transaction {
		t.Helper()
		transaction, err := fixture.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = transaction.Rollback() })
		return transaction
	}
	statement := func(t *testing.T, transaction Transaction, sql string) {
		t.Helper()
		if _, err := transaction.Executor.Query(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	visible := func(t *testing.T, orderID string, expected int) {
		t.Helper()
		var orders, tasks int
		err := fixture.Observer.QueryRow(ctx,
			"SELECT (SELECT count(*) FROM recipe_order WHERE id = $1::uuid), (SELECT count(*) FROM workhorse.task WHERE payload->>'orderId' = $1::text)", orderID).Scan(&orders, &tasks)
		if err != nil || orders != expected || tasks != expected {
			t.Fatalf("observer sees orders=%d tasks=%d; want %d: %v", orders, tasks, expected, err)
		}
	}
	write := func(t *testing.T, transaction Transaction) (string, string) {
		t.Helper()
		orderID := newID()
		taskID, err := transaction.Write(ctx, orderID, "order.accepted")
		if err != nil {
			t.Fatal(err)
		}
		return orderID, taskID
	}

	t.Run("physical_identity_invisibility_joint_commit_and_owner_lifecycle", func(t *testing.T) {
		transaction := begin(t)
		identity, err := transaction.Identity(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var observerPID int32
		if err := fixture.Observer.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&observerPID); err != nil || observerPID == identity.PID {
			t.Fatalf("observer must be independent: %d vs %d: %v", observerPID, identity.PID, err)
		}
		fixture.Trace.Reset()
		orderID, taskID := write(t, transaction)
		fixture.Trace.AssertBorrowed(t, identity.PID)
		order, err := transaction.Read(ctx, orderID)
		if err != nil || order.Identity != identity || order.ID != orderID || order.Note != nil || !json.Valid(order.Details) {
			t.Fatalf("native UUID/JSONB/null/business transaction decoding: %+v %v", order, err)
		}
		var details struct {
			Items []string `json:"items"`
		}
		if err := json.Unmarshal(order.Details, &details); err != nil || len(details.Items) != 2 || details.Items[0] != "first" || details.Items[1] != "second" {
			t.Fatalf("native JSONB contents: %s: %v", order.Details, err)
		}
		if _, err := transaction.Executor.Query(ctx, "UPDATE recipe_order SET note = $2 WHERE id = $1::uuid", orderID, "present"); err != nil {
			t.Fatal(err)
		}
		order, err = transaction.Read(ctx, orderID)
		if err != nil || order.Note == nil || *order.Note != "present" {
			t.Fatalf("non-null native business text: %+v %v", order, err)
		}
		rows, err := transaction.Executor.Query(ctx, "SELECT pg_backend_pid()::integer AS pid, pg_current_xact_id()::text AS xid, (pg_current_xact_id()::text::numeric % 4294967296)::text AS xid32, xmin::text AS task_xid FROM workhorse.task WHERE id = $1::uuid", taskID)
		if err != nil || len(rows) != 1 || fmt.Sprint(rows[0]["pid"]) != fmt.Sprint(identity.PID) || rows[0]["xid"] != identity.XID || rows[0]["task_xid"] != rows[0]["xid32"] {
			t.Fatalf("executor and durable task must share business transaction: %+v / %+v: %v", identity, rows, err)
		}
		visible(t, orderID, 0)
		if err := transaction.Commit(); err != nil {
			t.Fatal(err)
		}
		visible(t, orderID, 1)
		if _, err := transaction.Executor.Query(ctx, "SELECT 1"); err == nil {
			t.Fatal("transaction-bound executor cannot be used after owner commit")
		}
	})
	t.Run("joint_rollback", func(t *testing.T) {
		transaction := begin(t)
		orderID, _ := write(t, transaction)
		visible(t, orderID, 0)
		if err := transaction.Rollback(); err != nil {
			t.Fatal(err)
		}
		visible(t, orderID, 0)
	})
	t.Run("nested_savepoints_recover_inner_error", func(t *testing.T) {
		transaction := begin(t)
		outerID, _ := write(t, transaction)
		statement(t, transaction, "SAVEPOINT outer_recipe")
		middleID, _ := write(t, transaction)
		statement(t, transaction, "SAVEPOINT inner_recipe")
		innerID, _ := write(t, transaction)
		_, err := transaction.Executor.Query(ctx, "SELECT 1 / 0")
		var pgError *pgconn.PgError
		if !errors.As(err, &pgError) || pgError.Code != "22012" {
			t.Fatalf("structured inner error: %v", err)
		}
		_, err = transaction.Executor.Query(ctx, "SELECT 1")
		if !errors.As(err, &pgError) || pgError.Code != "25P02" {
			t.Fatalf("aborted transaction must remain aborted: %v", err)
		}
		statement(t, transaction, "ROLLBACK TO SAVEPOINT inner_recipe")
		statement(t, transaction, "RELEASE SAVEPOINT inner_recipe")
		statement(t, transaction, "RELEASE SAVEPOINT outer_recipe")
		continuedID, _ := write(t, transaction)
		if err := transaction.Commit(); err != nil {
			t.Fatal(err)
		}
		for _, orderID := range []string{outerID, middleID, continuedID} {
			visible(t, orderID, 1)
		}
		visible(t, innerID, 0)
	})
	t.Run("released_nested_savepoints_do_not_commit", func(t *testing.T) {
		transaction := begin(t)
		statement(t, transaction, "SAVEPOINT outer_recipe")
		statement(t, transaction, "SAVEPOINT inner_recipe")
		orderID, _ := write(t, transaction)
		statement(t, transaction, "RELEASE SAVEPOINT inner_recipe")
		statement(t, transaction, "RELEASE SAVEPOINT outer_recipe")
		visible(t, orderID, 0)
		if err := transaction.Rollback(); err != nil {
			t.Fatal(err)
		}
		visible(t, orderID, 0)
	})
	t.Run("jsonb_uuid_nullable_reason_and_ordered_batch", func(t *testing.T) {
		transaction := begin(t)
		queue := workhorse.NewQueue(transaction.Executor, "recipes")
		requests := make([]workhorse.EnqueueRequest, 3)
		for index := range requests {
			requests[index] = workhorse.EnqueueRequest{Type: "batch.recipe", Payload: map[string]any{"ordinal": index, "nested": map[string]any{"enabled": true}}}
		}
		results, err := queue.EnqueueManyWithResults(ctx, requests)
		if err != nil || len(results) != len(requests) {
			t.Fatalf("batch: %+v %v", results, err)
		}
		for index, result := range results {
			if result.Reason != nil || result.Outcome != workhorse.EnqueueAccepted {
				t.Fatalf("nullable accepted reason: %+v", result)
			}
			var ordinal int
			var nested bool
			rows, err := transaction.Executor.Query(ctx, "SELECT (payload->>'ordinal')::integer AS ordinal, (payload->'nested'->>'enabled')::boolean AS nested FROM workhorse.task WHERE id = $1::uuid", result.TaskID)
			if err != nil || len(rows) != 1 {
				t.Fatalf("UUID bind: %+v %v", rows, err)
			}
			ordinal, err = strconv.Atoi(fmt.Sprint(rows[0]["ordinal"]))
			nested, _ = rows[0]["nested"].(bool)
			if err != nil || ordinal != index || !nested {
				t.Fatalf("batch order/native JSONB: %+v", rows)
			}
		}
		first, err := queue.EnqueueWithResult(ctx, "key.recipe", map[string]any{"value": "same"}, workhorse.EnqueueOptions{Idempotency: &workhorse.Idempotency{Key: "retained", TTLMS: 60000}})
		if err != nil {
			t.Fatal(err)
		}
		retained, err := queue.EnqueueWithResult(ctx, "key.recipe", map[string]any{"value": "same"}, workhorse.EnqueueOptions{Debounce: &workhorse.Debounce{Key: "retained", WindowMS: 60000, Schedule: workhorse.DebounceReset}})
		if err != nil || retained.TaskID != first.TaskID || retained.Reason == nil || *retained.Reason != workhorse.NonReplaceableIncompatibleKeyMode {
			t.Fatalf("non-null canonical reason: %+v %v", retained, err)
		}
		statement(t, transaction, "SAVEPOINT conflict_recipe")
		_, err = queue.Enqueue(ctx, "key.recipe", map[string]any{"value": "different"}, workhorse.EnqueueOptions{Idempotency: &workhorse.Idempotency{Key: "retained", TTLMS: 60000}})
		var conflict *workhorse.EnqueueIdempotencyConflictError
		if !errors.As(err, &conflict) || !errors.Is(err, workhorse.ErrEnqueueIdempotencyConflict) || conflict.Details.ExistingTaskID != first.TaskID || !fixture.Trace.HasSQLState("P1001") {
			t.Fatalf("native structured SQLSTATE must become the core typed diagnosis: %v", err)
		}
		statement(t, transaction, "ROLLBACK TO SAVEPOINT conflict_recipe")
		statement(t, transaction, "RELEASE SAVEPOINT conflict_recipe")
		if _, err := queue.Enqueue(ctx, "recovered.recipe", nil); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("pre_cancelled_query_preserves_owner_transaction", func(t *testing.T) {
		transaction := begin(t)
		orderID, _ := write(t, transaction)
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		_, err := workhorse.NewQueue(transaction.Executor, "recipes").Enqueue(cancelled, "cancelled.recipe", nil)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("pre-cancelled call: %v", err)
		}
		if _, err := transaction.Executor.Query(ctx, "SELECT 1"); err != nil {
			t.Fatalf("pre-cancelled query took ownership: %v", err)
		}
		if err := transaction.Rollback(); err != nil {
			t.Fatal(err)
		}
		visible(t, orderID, 0)
	})
	t.Run("inflight_cancel_discards_pair_then_fresh_transaction_recovers", func(t *testing.T) {
		if _, err := fixture.Observer.Exec(ctx, `CREATE FUNCTION public.recipe_block_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_advisory_xact_lock(987654321); RETURN NEW; END $$;
CREATE TRIGGER recipe_block_enqueue BEFORE INSERT ON workhorse.task FOR EACH ROW EXECUTE FUNCTION public.recipe_block_enqueue()`); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if _, err := fixture.Observer.Exec(ctx, "DROP TRIGGER recipe_block_enqueue ON workhorse.task; DROP FUNCTION public.recipe_block_enqueue()"); err != nil {
				t.Errorf("remove scratch-only blocking trigger: %v", err)
			}
		})
		transaction := begin(t)
		identity, err := transaction.Identity(ctx)
		if err != nil {
			t.Fatal(err)
		}
		locker, err := fixture.Observer.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = locker.Rollback(ctx) }()
		if _, err := locker.Exec(ctx, "SELECT pg_advisory_xact_lock(987654321)"); err != nil {
			t.Fatal(err)
		}
		orderID := newID()
		blocked, cancel := context.WithCancel(ctx)
		defer cancel()
		finished := make(chan error, 1)
		go func() {
			_, err := transaction.Write(blocked, orderID, "order.accepted")
			finished <- err
		}()
		deadline := time.Now().Add(5 * time.Second)
		for {
			var waiting bool
			if err := fixture.Observer.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event = 'advisory')", identity.PID).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			if waiting {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("enqueue never reached the controlled database lock")
			}
			time.Sleep(time.Millisecond)
		}
		visible(t, orderID, 0)
		cancel()
		select {
		case err = <-finished:
		case <-time.After(5 * time.Second):
			t.Fatal("cancelled enqueue did not return")
		}
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("in-flight cancellation: %v", err)
		}
		_ = transaction.Rollback()
		if err := locker.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		visible(t, orderID, 0)
		recoveredID := newID()
		if _, err := fixture.Create(ctx, recoveredID, "order.accepted"); err != nil {
			t.Fatalf("fresh transaction recovery: %v", err)
		}
		visible(t, recoveredID, 1)
	})
	t.Run("actual_recipe_propagates_client_rejection_and_rolls_back", func(t *testing.T) {
		queue := workhorse.NewQueue(workhorse.NewPGXExecutor(fixture.Observer), "recipes")
		if err := queue.SyncContracts(ctx, map[string]workhorse.TaskTypeContracts{
			"rejected.recipe": {CurrentVersion: "1", Versions: map[string]workhorse.TaskContractVersion{
				"1": {PayloadSchema: map[string]any{
					"type": "object", "required": []any{"orderId"},
					"properties": map[string]any{"orderId": map[string]any{"type": "string", "minLength": 100}},
				}},
			}},
		}); err != nil {
			t.Fatal(err)
		}
		orderID := newID()
		_, err := fixture.Create(ctx, orderID, "rejected.recipe")
		var rejection *workhorse.TaskContractValidationError
		if !errors.As(err, &rejection) {
			t.Fatalf("expected core validation rejection: %v", err)
		}
		visible(t, orderID, 0)
	})
	t.Run("runnable_cli_commits_pair", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(ctx, time.Minute)
		defer cancel()
		command := exec.CommandContext(ctx, "go", "run", ".")
		command.Env = append(os.Environ(), "WORKHORSE_DATABASE_URL="+fixture.DatabaseURL)
		output, err := command.CombinedOutput()
		if err != nil || len(strings.TrimSpace(string(output))) != 36 {
			t.Fatalf("CLI: %s: %v", output, err)
		}
		visible(t, fixture.CLIOrderID, 1)
	})
}
