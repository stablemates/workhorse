package workhorse_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

type queueExecutor struct {
	responses [][]workhorse.Row
	errors    []error
	calls     []queueCall
}

type queueCall struct {
	statement string
	arguments []any
}

func (executor *queueExecutor) Query(
	_ context.Context,
	statement string,
	arguments ...any,
) ([]workhorse.Row, error) {
	executor.calls = append(executor.calls, queueCall{statement: statement, arguments: arguments})
	if len(executor.errors) > 0 {
		err := executor.errors[0]
		executor.errors = executor.errors[1:]
		if err != nil {
			return nil, err
		}
	}
	response := executor.responses[0]
	executor.responses = executor.responses[1:]
	return response, nil
}

func TestQueueSerializesMinimalRequestsAndReturnsCanonicalResults(t *testing.T) {
	executor := &queueExecutor{responses: [][]workhorse.Row{
		{{"version": int64(47)}},
		{
			{"ordinal": int32(1), "job_id": "first", "outcome": "accepted", "reason": nil},
			{"ordinal": int32(2), "job_id": "second", "outcome": "replayed", "reason": nil},
		},
	}}
	queue := workhorse.NewQueue(executor, "go-contract")

	results, err := queue.EnqueueManyWithResults(context.Background(), []workhorse.EnqueueRequest{
		{Type: "email.send", Payload: map[string]any{"message": "one"}},
		{Type: "email.send", Payload: map[string]any{"message": "two"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 || results[0].JobID != "first" || results[0].Outcome != workhorse.EnqueueAccepted ||
		results[1].JobID != "second" || results[1].Outcome != workhorse.EnqueueReplayed {
		t.Fatalf("unexpected results: %#v", results)
	}
	if len(executor.calls) != 2 {
		t.Fatalf("expected compatibility and enqueue calls, received %d", len(executor.calls))
	}
	var request []map[string]any
	encoded, ok := executor.calls[1].arguments[0].([]byte)
	if !ok {
		t.Fatalf("enqueue argument is %T, expected []byte", executor.calls[1].arguments[0])
	}
	if err := json.Unmarshal(encoded, &request); err != nil {
		t.Fatal(err)
	}
	if len(request) != 2 {
		t.Fatalf("unexpected decoded request: %#v", request)
	}
	if request[0]["queue"] != "go-contract" || request[0]["type"] != "email.send" ||
		request[0]["maxAttempts"] != float64(25) {
		t.Fatalf("unexpected request defaults: %#v", request[0])
	}
}

func TestQueueSatisfiesSharedRequestFixturesWithinCurrentScope(t *testing.T) {
	type requestFixture struct {
		ID          string `json:"id"`
		Application struct {
			Type    string         `json:"type"`
			Payload any            `json:"payload"`
			Options map[string]any `json:"options"`
		} `json:"application"`
		Postgres map[string]any `json:"postgres"`
	}

	exercised := 0
	for _, fixture := range readFixture[[]requestFixture](t, "requests.json") {
		if len(fixture.Application.Options) != 0 {
			continue
		}
		exercised++
		t.Run(fixture.ID, func(t *testing.T) {
			executor := &queueExecutor{responses: [][]workhorse.Row{
				{{"version": int64(47)}},
				{{"ordinal": int32(1), "job_id": "fixture", "outcome": "accepted", "reason": nil}},
			}}
			queueName, ok := fixture.Postgres["queue"].(string)
			if !ok {
				t.Fatalf("fixture queue is %T", fixture.Postgres["queue"])
			}
			queue := workhorse.NewQueue(executor, queueName)

			if _, err := queue.EnqueueWithResult(
				context.Background(),
				fixture.Application.Type,
				fixture.Application.Payload,
			); err != nil {
				t.Fatal(err)
			}
			var actual any
			if err := decodeJSON(executor.calls[1].arguments[0].([]byte), &actual); err != nil {
				t.Fatal(err)
			}
			actual, err := normalizeProtocolValue(actual)
			if err != nil {
				t.Fatal(err)
			}
			if err := matchFixtureValue(
				[]any{fixture.Postgres},
				actual,
				map[string]any{},
				fixture.ID,
			); err != nil {
				t.Fatal(err)
			}
		})
	}
	if exercised == 0 {
		t.Fatal("protocol/v1/requests.json has no request within the current Go option scope")
	}
}

func TestQueuePlacesResultsByValidatedOrdinal(t *testing.T) {
	executor := &queueExecutor{responses: [][]workhorse.Row{
		{{"version": int64(47)}},
		{
			{"ordinal": int32(2), "job_id": "second", "outcome": "accepted", "reason": nil},
			{"ordinal": int32(1), "job_id": "first", "outcome": "accepted", "reason": nil},
		},
	}}
	queue := workhorse.NewQueue(executor, "default")

	results, err := queue.EnqueueManyWithResults(context.Background(), []workhorse.EnqueueRequest{
		{Type: "email.send", Payload: nil},
		{Type: "email.send", Payload: nil},
	})
	if err != nil {
		t.Fatal(err)
	}
	if results[0].JobID != "first" || results[1].JobID != "second" {
		t.Fatalf("results do not follow request ordinals: %#v", results)
	}
}

func TestQueueRejectsIncompleteOrdinalResults(t *testing.T) {
	executor := &queueExecutor{responses: [][]workhorse.Row{
		{{"version": int64(47)}},
		{},
	}}
	queue := workhorse.NewQueue(executor, "default")

	_, err := queue.Enqueue(context.Background(), "email.send", nil)
	if !errors.Is(err, workhorse.ErrInvalidEnqueueResult) {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestQueueRefusesIncompatibleSchemaBeforeMutation(t *testing.T) {
	executor := &queueExecutor{responses: [][]workhorse.Row{{{"version": int64(46)}}}}
	queue := workhorse.NewQueue(executor, "default")

	_, err := queue.Enqueue(context.Background(), "email.send", map[string]any{"message": "hello"})
	var compatibilityError *workhorse.CompatibilityError
	if !errors.As(err, &compatibilityError) || compatibilityError.Code != workhorse.SchemaTooOld {
		t.Fatalf("unexpected error: %v", err)
	}
	if !errors.Is(err, &workhorse.CompatibilityError{Code: workhorse.SchemaTooOld}) {
		t.Fatalf("compatibility error does not match by code: %v", err)
	}
	if len(executor.calls) != 1 {
		t.Fatalf("expected only compatibility query, received %d calls", len(executor.calls))
	}
}

func TestQueueTranslatesStructuredPostgreSQLErrors(t *testing.T) {
	tests := []struct {
		name     string
		code     string
		detail   string
		sentinel error
		assert   func(*testing.T, error)
	}{
		{
			name:     "idempotency conflict",
			code:     "P1001",
			detail:   `{"ordinal":2,"conflictingFields":["payload"]}`,
			sentinel: workhorse.ErrEnqueueIdempotencyConflict,
			assert: func(t *testing.T, err error) {
				var conflict *workhorse.EnqueueIdempotencyConflictError
				if !errors.As(err, &conflict) || conflict.Details.Ordinal != 2 {
					t.Fatalf("structured details were not preserved: %#v", conflict)
				}
			},
		},
		{
			name:     "dependency cycle",
			code:     "P1003",
			detail:   `{"dependentJobId":"dependent","prerequisiteJobId":"prerequisite","cycleJobIds":["dependent","prerequisite"],"truncated":false}`,
			sentinel: workhorse.ErrDependencyCycle,
			assert: func(t *testing.T, err error) {
				var cycle *workhorse.DependencyCycleError
				if !errors.As(err, &cycle) || cycle.Details.PrerequisiteJobID != "prerequisite" {
					t.Fatalf("structured details were not preserved: %#v", cycle)
				}
			},
		},
		{
			name:     "dependency limit",
			code:     "P1005",
			detail:   `{"jobId":"limited","limit":"dependents","max":100}`,
			sentinel: workhorse.ErrDependencyLimitExceeded,
			assert: func(t *testing.T, err error) {
				var limit *workhorse.DependencyLimitExceededError
				if !errors.As(err, &limit) || limit.Details.Limit != workhorse.DependencyDependents {
					t.Fatalf("structured details were not preserved: %#v", limit)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			executor := &queueExecutor{
				responses: [][]workhorse.Row{{{"version": int64(47)}}},
				errors:    []error{nil, &pgconn.PgError{Code: test.code, Detail: test.detail}},
			}
			queue := workhorse.NewQueue(executor, "default")

			_, err := queue.Enqueue(
				context.Background(),
				"email.send",
				map[string]any{"message": "hello"},
			)
			if !errors.Is(err, test.sentinel) {
				t.Fatalf("unexpected error: %v", err)
			}
			test.assert(t, err)
		})
	}
}

func TestQueueEmptyBatchDoesNotQueryPostgreSQL(t *testing.T) {
	executor := &queueExecutor{}
	queue := workhorse.NewQueue(executor, "default")

	jobIDs, err := queue.EnqueueMany(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobIDs) != 0 || len(executor.calls) != 0 {
		t.Fatalf("unexpected empty batch result: ids=%#v calls=%#v", jobIDs, executor.calls)
	}
}

func TestQueueRejectsBatchAboveSharedLimitBeforeQuery(t *testing.T) {
	executor := &queueExecutor{}
	queue := workhorse.NewQueue(executor, "default")
	requests := make([]workhorse.EnqueueRequest, workhorse.MaxEnqueueBatchSize+1)

	_, err := queue.EnqueueMany(context.Background(), requests)
	if !errors.Is(err, workhorse.ErrEnqueueBatchTooLarge) {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(executor.calls) != 0 {
		t.Fatalf("oversized batch queried PostgreSQL: %#v", executor.calls)
	}
}

func TestQueueLeavesTransactionCommitAndRollbackWithCaller(t *testing.T) {
	ctx := context.Background()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "queue-transaction")
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(transaction), "transactions")
	jobID, err := queue.Enqueue(ctx, "email.send", map[string]any{"message": "commit"})
	if err != nil {
		t.Fatal(err)
	}
	assertJobCount(t, pool, jobID, 0)
	if err := transaction.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	assertJobCount(t, pool, jobID, 1)

	transaction, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	queue = workhorse.NewQueue(workhorse.NewPGXExecutor(transaction), "transactions")
	rolledBackID, err := queue.Enqueue(ctx, "email.send", map[string]any{"message": "rollback"})
	if err != nil {
		t.Fatal(err)
	}
	if err := transaction.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	assertJobCount(t, pool, rolledBackID, 0)
}

func TestDatabaseSQLQueueUsesCallerOwnedTransaction(t *testing.T) {
	ctx := context.Background()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "queue-database-sql")
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	transaction, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	queue := workhorse.NewQueue(workhorse.NewSQLExecutor(transaction), "transactions")
	jobID, err := queue.Enqueue(ctx, "email.send", map[string]any{"message": "commit"})
	if err != nil {
		t.Fatal(err)
	}
	assertJobCount(t, pool, jobID, 0)
	if err := transaction.Commit(); err != nil {
		t.Fatal(err)
	}
	assertJobCount(t, pool, jobID, 1)
}

func TestQueueBatchFailureIsAtomic(t *testing.T) {
	ctx := context.Background()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "queue-atomic-batch")
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "atomic-batch")

	_, err = queue.EnqueueMany(ctx, []workhorse.EnqueueRequest{
		{Type: "email.send", Payload: map[string]any{"message": "valid"}},
		{Type: "", Payload: map[string]any{"message": "invalid"}},
	})
	if err == nil {
		t.Fatal("expected PostgreSQL to reject the invalid batch")
	}
	var count int
	if err := pool.QueryRow(
		ctx,
		"SELECT count(*)::integer FROM workhorse.job WHERE queue_name = $1",
		"atomic-batch",
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("failed batch inserted %d jobs", count)
	}
}

func assertJobCount(t *testing.T, pool *pgxpool.Pool, jobID string, want int) {
	t.Helper()
	var count int
	if err := pool.QueryRow(
		context.Background(),
		"SELECT count(*)::integer FROM workhorse.job WHERE id = $1::uuid",
		jobID,
	).Scan(&count); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("job %s count: expected %d, received %d", jobID, want, count)
	}
}
