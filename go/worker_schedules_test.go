package workhorse_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func TestWorkerFiresSchedulesWhenAnotherWorkerOwnsTheMaintenanceTick(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-schedule-lock")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "scheduled")
	if err := queue.SyncSchedules(ctx, "go-worker", []workhorse.ScheduleDefinition{{
		Name: "billing-rollup", Schedule: "* * * * * *",
		Job: workhorse.ScheduledJob{Type: "billing.rollup", Payload: map[string]any{}},
	}}); err != nil {
		t.Fatal(err)
	}

	lock, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lock.Rollback(ctx) }()
	if _, err := lock.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended('workhorse:tick', 0))"); err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "scheduled", WorkerID: "go-schedule-lock-worker", ScheduleNamespaces: []string{"go-worker"},
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("billing.rollup", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return map[string]any{"fired": true}, nil
	})

	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("locked maintenance run: processed=%t err=%v", processed, err)
	}
	assertScheduleOccurrenceCount(t, ctx, pool, "go-worker", "billing-rollup", 1)
}

func TestWorkerLimitsScheduleCatchup(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-schedule-catchup")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "scheduled")
	if err := queue.SyncSchedules(ctx, "go-worker", []workhorse.ScheduleDefinition{{
		Name: "billing-rollup", Schedule: "* * * * * *",
		Job: workhorse.ScheduledJob{Type: "billing.rollup", Payload: map[string]any{}},
	}}); err != nil {
		t.Fatal(err)
	}
	var revision int64
	if err := pool.QueryRow(
		ctx,
		"SELECT revision FROM workhorse.schedule_definition WHERE namespace = 'go-worker' AND schedule_name = 'billing-rollup'",
	).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	seed := time.Now().UTC().Truncate(time.Second).Add(-6 * time.Second)
	var seededJobID string
	if err := pool.QueryRow(
		ctx,
		"SELECT workhorse.fire_schedule_v1($1, $2, $3, $4)",
		"go-worker", "billing-rollup", revision, seed,
	).Scan(&seededJobID); err != nil {
		t.Fatal(err)
	}

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "scheduled", WorkerID: "go-schedule-catchup-worker", ScheduleNamespaces: []string{"go-worker"},
		ScheduleCatchupLimit: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("billing.rollup", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return map[string]any{"fired": true}, nil
	})
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("catch-up run: processed=%t err=%v", processed, err)
	}
	assertScheduleOccurrenceCount(t, ctx, pool, "go-worker", "billing-rollup", 3)
}

func assertScheduleOccurrenceCount(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	namespace string,
	name string,
	want int,
) {
	t.Helper()
	var count int
	if err := pool.QueryRow(
		ctx,
		"SELECT count(*)::integer FROM workhorse.schedule_occurrence WHERE namespace = $1 AND schedule_name = $2",
		namespace,
		name,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("schedule occurrence count: expected %d, received %d", want, count)
	}
}

func TestWorkerValidatesScheduleOptions(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-schedule-options")
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	for _, options := range []workhorse.WorkerOptions{
		{ScheduleNamespaces: []string{"billing", ""}},
		{ScheduleCatchupLimit: -1},
		{ScheduleCatchupLimit: 10_001},
	} {
		if _, err := workhorse.NewWorker(pool, options); err == nil {
			t.Fatalf("expected invalid schedule options to fail: %#v", options)
		}
	}

	if _, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		ScheduleNamespaces:   []string{"billing", "billing"},
		ScheduleCatchupLimit: 10_000,
	}); err != nil {
		t.Fatalf("expected valid schedule options: %v", err)
	}
}
