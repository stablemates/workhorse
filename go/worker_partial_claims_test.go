package workhorse_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// rejectClaimsOnQueue makes every claim against queueName raise. The claim moves a ready row to
// active, so a trigger on that transition fails the claim query the worker issues for that queue
// while claims against every other queue keep committing. The database is a throwaway copy.
func rejectClaimsOnQueue(t *testing.T, ctx context.Context, pool *pgxpool.Pool, queueName string) {
	t.Helper()
	if _, err := pool.Exec(ctx, fmt.Sprintf(`
CREATE FUNCTION workhorse.test_reject_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'ready' AND NEW.state = 'active' AND NEW.queue_name = '%s' THEN
    RAISE EXCEPTION 'claim rejected for test queue';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER test_reject_claim BEFORE UPDATE ON workhorse.task_runtime
  FOR EACH ROW EXECUTE FUNCTION workhorse.test_reject_claim()`, queueName)); err != nil {
		t.Fatal(err)
	}
}

// A claim fills its slots from one queue at a time, and the database commits each queue's claim on
// its own. A task claimed from an earlier queue therefore holds a lease no matter how a later
// queue's claim ends, and abandoning it would burn one of its attempts at lease recovery.
func TestWorkerRunsTasksClaimedBeforeALaterQueueFails(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-partial-claims")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	healthyQueue := "go-partial-healthy"
	failingQueue := "go-partial-failing"
	executor := workhorse.NewPGXExecutor(pool)
	healthy := workhorse.NewQueue(executor, healthyQueue)
	taskID, err := healthy.Enqueue(ctx, "settle", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	failing := workhorse.NewQueue(executor, failingQueue)
	if _, err := failing.Enqueue(ctx, "settle", nil); err != nil {
		t.Fatal(err)
	}
	rejectClaimsOnQueue(t, ctx, pool, failingQueue)

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queues:              []string{healthyQueue, failingQueue},
		WorkerID:            "go-partial-claims-worker",
		Concurrency:         2,
		LeaseDuration:       time.Second,
		HeartbeatInterval:   100 * time.Millisecond,
		PollInterval:        10 * time.Millisecond,
		MaintenanceInterval: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	handled := make(chan string, 2)
	worker.Handle("settle", func(_ context.Context, _ any, durability *workhorse.HandlerContext) (any, error) {
		handled <- durability.Task.ID
		return nil, nil
	})
	workerResult := make(chan error, 1)
	go func() { workerResult <- worker.Run(ctx) }()

	select {
	case handledID := <-handled:
		if handledID != taskID {
			t.Fatalf("expected the healthy queue's task %s, received %s", taskID, handledID)
		}
	case err := <-workerResult:
		t.Fatalf("worker returned before running the task it had already claimed: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("the task claimed before the failing queue never ran")
	}

	select {
	case err := <-workerResult:
		if err == nil || !strings.Contains(err.Error(), "claim rejected for test queue") {
			t.Fatalf("expected the failing queue's claim error, received %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("worker did not surface the claim error")
	}
	assertWorkerFixtureTaskState(t, ctx, pool, taskID, workerFixtureTaskState{State: "succeeded", Attempt: 1})
	assertWorkerFixtureAttemptOutcomes(t, ctx, pool, taskID, []string{"succeeded"})
}

// A claim that fails before it commits any task leaves the worker nothing to run, and polling on
// would hide the failure for as long as the worker lives.
func TestWorkerStopsWhenAClaimFailsWithoutClaimingATask(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-failing-claim")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-failing-claim"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	if _, err := queue.Enqueue(ctx, "settle", nil); err != nil {
		t.Fatal(err)
	}
	rejectClaimsOnQueue(t, ctx, pool, queueName)

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "go-failing-claim-worker",
		LeaseDuration:       time.Second,
		HeartbeatInterval:   100 * time.Millisecond,
		PollInterval:        10 * time.Millisecond,
		MaintenanceInterval: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("settle", func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		return nil, nil
	})
	workerResult := make(chan error, 1)
	go func() { workerResult <- worker.Run(ctx) }()

	select {
	case err := <-workerResult:
		if err == nil || !strings.Contains(err.Error(), "claim rejected for test queue") {
			t.Fatalf("expected the failing claim error, received %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("worker kept polling instead of surfacing the failing claim")
	}
}
