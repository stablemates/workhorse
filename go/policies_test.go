package workhorse_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	workhorse "github.com/stablemates/workhorse/go"
)

func TestQueueSynchronizesAndListsConcurrencyPoliciesThroughPGX(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-concurrency-policies")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = transaction.Rollback(ctx) })
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(transaction), "default")
	perKey := 2

	policies, err := queue.SyncConcurrencyPolicies(ctx, "go-deployment", []workhorse.ConcurrencyPolicyDefinition{
		{Queue: "mail", MaxActive: 8, MaxActivePerKey: &perKey},
		{Queue: "reports", MaxActive: 3},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(policies) != 2 || policies[0].Queue != "mail" || policies[0].MaxActive != 8 ||
		policies[0].MaxActivePerKey == nil || *policies[0].MaxActivePerKey != 2 ||
		policies[1].Queue != "reports" || policies[1].MaxActivePerKey != nil ||
		policies[0].UpdatedAt.IsZero() {
		t.Fatalf("unexpected synchronized policies: %#v", policies)
	}
	if _, err := queue.SyncConcurrencyPolicies(
		ctx,
		"go-deployment",
		[]workhorse.ConcurrencyPolicyDefinition{{Queue: "mail", MaxActive: 5}},
		workhorse.SyncPolicyOptions{Prune: false},
	); err != nil {
		t.Fatal(err)
	}
	policies, err = queue.ListConcurrencyPolicies(ctx, []string{"reports", "mail"})
	if err != nil {
		t.Fatal(err)
	}
	if len(policies) != 2 || policies[0].Queue != "mail" || policies[0].MaxActive != 5 ||
		policies[1].Queue != "reports" {
		t.Fatalf("optional pruning did not preserve omitted policy: %#v", policies)
	}

	if _, err := queue.SyncConcurrencyPolicies(
		ctx,
		"go-deployment",
		[]workhorse.ConcurrencyPolicyDefinition{{Queue: "mail", MaxActive: 4}},
	); err != nil {
		t.Fatal(err)
	}
	policies, err = queue.ListConcurrencyPolicies(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(policies) != 1 || policies[0].Queue != "mail" || policies[0].MaxActive != 4 {
		t.Fatalf("authoritative synchronization did not prune omitted policy: %#v", policies)
	}
	_, err = queue.SyncConcurrencyPolicies(ctx, "go-deployment", []workhorse.ConcurrencyPolicyDefinition{
		{Queue: "mail", MaxActive: 1, MaxActivePerKey: &perKey},
	})
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) || databaseError.Code != "P0001" {
		t.Fatalf("policy validation did not return a structured PostgreSQL error: %v", err)
	}

	if err := transaction.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	outside := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "default")
	policies, err = outside.ListConcurrencyPolicies(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(policies) != 0 {
		t.Fatalf("queue committed its caller-owned transaction: %#v", policies)
	}
}

func TestQueueSynchronizesAndListsRateLimitPoliciesThroughDatabaseSQL(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-rate-limit-policies")
	ctx := context.Background()
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	transaction, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = transaction.Rollback() })
	queue := workhorse.NewQueue(workhorse.NewSQLExecutor(transaction), "default")

	policies, err := queue.SyncRateLimitPolicies(ctx, "go-deployment", []workhorse.RateLimitPolicyDefinition{
		{
			Queue:  "mail",
			Rate:   workhorse.RateLimit{Limit: 10, IntervalMS: 1_000, Burst: 20},
			PerKey: &workhorse.RateLimit{Limit: 2, IntervalMS: 5_000, Burst: 3},
		},
		{Queue: "reports", Rate: workhorse.RateLimit{Limit: 1, IntervalMS: 60_000, Burst: 1}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(policies) != 2 || policies[0].Queue != "mail" || policies[0].Rate.Limit != 10 ||
		policies[0].PerKey == nil || policies[0].PerKey.IntervalMS != 5_000 ||
		policies[1].Queue != "reports" || policies[1].PerKey != nil || policies[0].UpdatedAt.IsZero() {
		t.Fatalf("unexpected synchronized rate-limit policies: %#v", policies)
	}

	if _, err := queue.SyncRateLimitPolicies(
		ctx,
		"go-deployment",
		[]workhorse.RateLimitPolicyDefinition{{
			Queue: "mail",
			Rate:  workhorse.RateLimit{Limit: 20, IntervalMS: 2_000, Burst: 30},
		}},
		workhorse.SyncPolicyOptions{Prune: false},
	); err != nil {
		t.Fatal(err)
	}
	policies, err = queue.ListRateLimitPolicies(ctx, []string{"reports", "mail"})
	if err != nil {
		t.Fatal(err)
	}
	if len(policies) != 2 || policies[0].Queue != "mail" || policies[0].Rate.Limit != 20 ||
		policies[1].Queue != "reports" {
		t.Fatalf("optional pruning did not preserve omitted rate policy: %#v", policies)
	}

	if _, err := queue.SyncRateLimitPolicies(ctx, "go-deployment", nil); err != nil {
		t.Fatal(err)
	}
	policies, err = queue.ListRateLimitPolicies(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(policies) != 0 {
		t.Fatalf("empty authoritative synchronization did not prune policies: %#v", policies)
	}

	if err := transaction.Rollback(); err != nil {
		t.Fatal(err)
	}
	outside := workhorse.NewQueue(workhorse.NewSQLExecutor(database), "default")
	policies, err = outside.ListRateLimitPolicies(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(policies) != 0 {
		t.Fatalf("queue committed its caller-owned transaction: %#v", policies)
	}
}

func TestQueueSynchronizesAndListsBudgetsThroughPGX(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-budgets")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = transaction.Rollback(ctx) })
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(transaction), "default")
	maxActive := 3

	budgets, err := queue.SyncBudgets(ctx, "go-deployment", []workhorse.BudgetDefinition{
		{Name: "vendor-api", MaxActive: &maxActive, Rate: &workhorse.RateLimit{Limit: 5, IntervalMS: 1_000, Burst: 10}},
		{Name: "slow-partner", Rate: &workhorse.RateLimit{Limit: 1, IntervalMS: 60_000, Burst: 1}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(budgets) != 2 || budgets[0].Name != "slow-partner" || budgets[0].MaxActive != nil ||
		budgets[0].Rate == nil || budgets[0].Rate.IntervalMS != 60_000 ||
		budgets[1].Name != "vendor-api" || budgets[1].MaxActive == nil || *budgets[1].MaxActive != 3 ||
		budgets[1].Rate == nil || budgets[1].Rate.Limit != 5 || budgets[1].UpdatedAt.IsZero() {
		t.Fatalf("unexpected synchronized budgets: %#v", budgets)
	}
	if _, err := queue.SyncBudgets(
		ctx,
		"go-deployment",
		[]workhorse.BudgetDefinition{{Name: "vendor-api", MaxActive: &maxActive}},
		workhorse.SyncPolicyOptions{Prune: false},
	); err != nil {
		t.Fatal(err)
	}
	budgets, err = queue.ListBudgets(ctx, []string{"vendor-api", "slow-partner"})
	if err != nil {
		t.Fatal(err)
	}
	if len(budgets) != 2 || budgets[1].Name != "vendor-api" || budgets[1].Rate != nil {
		t.Fatalf("optional pruning did not preserve omitted budget: %#v", budgets)
	}
	if _, err := queue.SyncBudgets(ctx, "go-deployment", nil); err != nil {
		t.Fatal(err)
	}
	budgets, err = queue.ListBudgets(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(budgets) != 0 {
		t.Fatalf("empty authoritative synchronization did not prune budgets: %#v", budgets)
	}
	_, err = queue.SyncBudgets(ctx, "go-deployment", []workhorse.BudgetDefinition{{Name: "vendor-api"}})
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) || databaseError.Code != "P0001" {
		t.Fatalf("budget validation did not return a structured PostgreSQL error: %v", err)
	}
}

func TestPolicySynchronizationRefusesIncompatibleSchemaBeforeMutation(t *testing.T) {
	// The installed schema declares that it serves a later protocol only, so it has crossed a major
	// boundary and no longer answers this client. A newer schema version alone is not a refusal.
	executor := &queueExecutor{responses: [][]workhorse.Row{{
		{"kind": "schema", "version": int64(testSchemaVersion)},
		{"kind": "protocol", "version": int64(workhorse.ProtocolVersion + 1)},
	}}}
	queue := workhorse.NewQueue(executor, "default")

	_, err := queue.SyncConcurrencyPolicies(context.Background(), "deployment", nil)
	if !errors.Is(err, &workhorse.CompatibilityError{Code: workhorse.SchemaTooNew}) {
		t.Fatalf("unexpected compatibility error: %v", err)
	}
	if len(executor.calls) != 1 {
		t.Fatalf("incompatible schema reached policy mutation: %#v", executor.calls)
	}
}

func TestPolicyReadsRejectMalformedDatabaseRows(t *testing.T) {
	executor := &queueExecutor{responses: [][]workhorse.Row{{{
		"namespace": "deployment", "queue_name": "mail", "max_active": "eight",
		"max_active_per_key": nil, "updated_at": "today",
	}}}}
	queue := workhorse.NewQueue(executor, "default")

	_, err := queue.ListConcurrencyPolicies(context.Background(), nil)
	if !errors.Is(err, workhorse.ErrInvalidPolicyResult) {
		t.Fatalf("unexpected malformed-result error: %v", err)
	}
}

// syncFailureExecutor replaces the first forced sync statements with one that PostgreSQL rejects
// with code. The replacement really fails, so inside a transaction it aborts that transaction
// exactly as a deadlock would. codes records the SQLSTATE of each sync statement, or "" on success.
type syncFailureExecutor struct {
	executor workhorse.Executor
	code     string
	forced   int
	codes    []string
}

func (executor *syncFailureExecutor) Query(
	ctx context.Context,
	statement string,
	arguments ...any,
) ([]workhorse.Row, error) {
	if !strings.Contains(statement, "workhorse.sync_concurrency_policies_v1(") {
		return executor.executor.Query(ctx, statement, arguments...)
	}
	var rows []workhorse.Row
	var err error
	if len(executor.codes) < executor.forced {
		rows, err = executor.executor.Query(ctx, fmt.Sprintf(
			"DO $$ BEGIN RAISE EXCEPTION 'forced sync failure' USING ERRCODE = '%s'; END $$",
			executor.code,
		))
	} else {
		rows, err = executor.executor.Query(ctx, statement, arguments...)
	}
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) {
		executor.codes = append(executor.codes, databaseError.Code)
	} else {
		executor.codes = append(executor.codes, "")
	}
	return rows, err
}

func TestSyncConcurrencyPoliciesResendsADeadlockVictim(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-policy-sync-deadlock")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	definitions := []workhorse.ConcurrencyPolicyDefinition{{Queue: "mail", MaxActive: 2}}

	executor := &syncFailureExecutor{executor: workhorse.NewPGXExecutor(pool), code: "40P01", forced: 1}
	policies, err := workhorse.NewQueue(executor, "default").
		SyncConcurrencyPolicies(ctx, "go-deadlock", definitions)
	if err != nil {
		t.Fatal(err)
	}
	if len(policies) != 1 || policies[0].Queue != "mail" || policies[0].MaxActive != 2 {
		t.Fatalf("unexpected synchronized policies: %#v", policies)
	}
	if strings.Join(executor.codes, ",") != "40P01," {
		t.Fatalf("sync statements answered %q", executor.codes)
	}

	executor = &syncFailureExecutor{executor: workhorse.NewPGXExecutor(pool), code: "40P01", forced: 3}
	_, err = workhorse.NewQueue(executor, "default").SyncConcurrencyPolicies(ctx, "go-deadlock", definitions)
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) || databaseError.Code != "40P01" || len(executor.codes) != 3 {
		t.Fatalf("persistent deadlock answered %v after %q", err, executor.codes)
	}

	executor = &syncFailureExecutor{executor: workhorse.NewPGXExecutor(pool), code: "40001", forced: 1}
	_, err = workhorse.NewQueue(executor, "default").SyncConcurrencyPolicies(ctx, "go-deadlock", definitions)
	if !errors.As(err, &databaseError) || databaseError.Code != "40001" || len(executor.codes) != 1 {
		t.Fatalf("another error answered %v after %q", err, executor.codes)
	}
}

func TestSyncConcurrencyPoliciesReportsTheDeadlockThatAbortedACallerTransaction(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-policy-sync-deadlock-tx")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = transaction.Rollback(ctx) })

	executor := &syncFailureExecutor{executor: workhorse.NewPGXExecutor(transaction), code: "40P01", forced: 1}
	_, err = workhorse.NewQueue(executor, "default").SyncConcurrencyPolicies(
		ctx,
		"go-deadlock",
		[]workhorse.ConcurrencyPolicyDefinition{{Queue: "mail", MaxActive: 1}},
	)
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) || databaseError.Code != "40P01" ||
		databaseError.Message != "forced sync failure" {
		t.Fatalf("aborted transaction answered %v", err)
	}
	if strings.Join(executor.codes, ",") != "40P01,25P02" {
		t.Fatalf("sync statements answered %q", executor.codes)
	}
}
