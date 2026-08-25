package workhorse_test

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"testing"
	"time"

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
	assertAdminQuery(t, workhorse.NewPGXExecutor(connection))
	assertPolicyQuery(t, workhorse.NewPGXExecutor(connection))

	transaction, err := connection.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = transaction.Rollback(ctx) })
	assertQuery(t, workhorse.NewPGXExecutor(transaction))
	assertAdminQuery(t, workhorse.NewPGXExecutor(transaction))
	assertPolicyQuery(t, workhorse.NewPGXExecutor(transaction))
	assertQuery(t, workhorse.NewPGXExecutor(transaction))
	if err := transaction.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	assertQuery(t, workhorse.NewPGXExecutor(pool))
	assertAdminQuery(t, workhorse.NewPGXExecutor(pool))
	assertPolicyQuery(t, workhorse.NewPGXExecutor(pool))
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
	assertAdminQuery(t, workhorse.NewSQLExecutor(database))
	assertPolicyQuery(t, workhorse.NewSQLExecutor(database))

	connection, err := database.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	assertQuery(t, workhorse.NewSQLExecutor(connection))
	assertAdminQuery(t, workhorse.NewSQLExecutor(connection))
	assertPolicyQuery(t, workhorse.NewSQLExecutor(connection))

	transaction, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = transaction.Rollback() })
	assertQuery(t, workhorse.NewSQLExecutor(transaction))
	assertAdminQuery(t, workhorse.NewSQLExecutor(transaction))
	assertPolicyQuery(t, workhorse.NewSQLExecutor(transaction))
	assertQuery(t, workhorse.NewSQLExecutor(transaction))
	if err := transaction.Rollback(); err != nil {
		t.Fatal(err)
	}
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

func assertAdminQuery(t *testing.T, executor workhorse.Executor) {
	t.Helper()
	ctx := context.Background()
	admin := workhorse.NewAdmin(executor)
	jobID := "00000000-0000-4000-8000-000000000001"
	queueName := fmt.Sprintf("executor-test-%d", time.Now().UnixNano())
	audit := func(operation string) workhorse.AdminAudit {
		return workhorse.AdminAudit{
			Actor:     "executor-test",
			Reason:    "verify public Admin",
			RequestID: fmt.Sprintf("%s-%s-%d", t.Name(), operation, time.Now().UnixNano()),
		}
	}
	page, err := admin.ListJobs(ctx, workhorse.JobListQuery{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) > 1 {
		t.Fatalf("Admin limit was not respected: %#v", page)
	}
	if _, err := admin.GetJob(ctx, jobID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.GetJobTimeline(ctx, jobID, workhorse.JobTimelineQuery{Limit: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.ListDeadLetters(ctx, workhorse.DeadLetterQuery{Limit: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Redrive(ctx, jobID, audit("redrive")); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.RedriveMany(ctx, workhorse.DeadLetterFilter{}, audit("redrive-many"), workhorse.BulkRedriveOptions{Limit: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.GetCheckpoint(ctx, jobID, "checkpoint"); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.ListCheckpoints(ctx, jobID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.GetProgress(ctx, jobID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.GetWait(ctx, jobID, "wait"); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.ListWaits(ctx, jobID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.ListSignalWaits(ctx, workhorse.ExternalWaitQuery{Limit: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.ListHumanWaits(ctx, workhorse.ExternalWaitQuery{Limit: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.ListWorkers(ctx); err != nil {
		t.Fatal(err)
	}
	if err := admin.PauseQueue(ctx, queueName, audit("pause-queue")); err != nil {
		t.Fatal(err)
	}
	if err := admin.ResumeQueue(ctx, queueName, audit("resume-queue")); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.PurgeQueue(ctx, queueName, audit("purge-queue")); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.SetWorkerPaused(ctx, "missing-worker", true, audit("pause-worker")); err != nil {
		t.Fatal(err)
	}
}

func assertPolicyQuery(t *testing.T, executor workhorse.Executor) {
	t.Helper()
	ctx := context.Background()
	namespace := fmt.Sprintf("executor-policy-%d", time.Now().UnixNano())
	queueName := namespace + "-queue"
	queue := workhorse.NewQueue(executor, "default")

	concurrency, err := queue.SyncConcurrencyPolicies(ctx, namespace, []workhorse.ConcurrencyPolicyDefinition{{
		Queue: queueName, MaxActive: 2,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if listed, err := queue.ListConcurrencyPolicies(ctx, []string{queueName}); err != nil {
		t.Fatal(err)
	} else if len(concurrency) != 1 || len(listed) != 1 || listed[0].Queue != queueName {
		t.Fatalf("unexpected concurrency policies: synchronized=%#v listed=%#v", concurrency, listed)
	}

	rateLimits, err := queue.SyncRateLimitPolicies(ctx, namespace, []workhorse.RateLimitPolicyDefinition{{
		Queue: queueName, Rate: workhorse.RateLimit{Limit: 2, IntervalMS: 1_000, Burst: 2},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if listed, err := queue.ListRateLimitPolicies(ctx, []string{queueName}); err != nil {
		t.Fatal(err)
	} else if len(rateLimits) != 1 || len(listed) != 1 || listed[0].Queue != queueName {
		t.Fatalf("unexpected rate-limit policies: synchronized=%#v listed=%#v", rateLimits, listed)
	}

	if _, err := queue.SyncConcurrencyPolicies(ctx, namespace, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.SyncRateLimitPolicies(ctx, namespace, nil); err != nil {
		t.Fatal(err)
	}
}

func testDatabaseURL(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("PostgreSQL integration tests do not run in short mode")
	}

	databaseURL := os.Getenv("DATABASE_URL_TEST")
	if databaseURL == "" {
		t.Skip("DATABASE_URL_TEST is required for integration tests")
	}
	return databaseURL
}
