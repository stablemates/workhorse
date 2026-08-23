package workhorse_test

import (
	"context"
	"database/sql"
	"errors"
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

func TestPolicySynchronizationRefusesIncompatibleSchemaBeforeMutation(t *testing.T) {
	executor := &queueExecutor{responses: [][]workhorse.Row{{{"version": int64(2)}}}}
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
