package workhorse_test

import (
	"context"
	"errors"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func fastTierPool(t *testing.T, name string) *pgxpool.Pool {
	t.Helper()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), name)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func fastTierAudit() workhorse.AdminAudit {
	return workhorse.AdminAudit{Actor: "go-fast-tier-test", Reason: "exercise the fast tier", RequestID: "fast-tier"}
}

func makeFastQueue(t *testing.T, pool *pgxpool.Pool, queue string) {
	t.Helper()
	admin := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool))
	tier, err := admin.SetQueueTier(context.Background(), queue, workhorse.QueueTierFast, fastTierAudit())
	if err != nil {
		t.Fatal(err)
	}
	if tier != workhorse.QueueTierFast {
		t.Fatalf("queue %s has tier %s", queue, tier)
	}
}

type fastOutcome struct {
	TaskID  string
	State   string
	Attempt int
}

func fastOutcomes(t *testing.T, pool *pgxpool.Pool, taskIDs []string) []fastOutcome {
	t.Helper()
	rows, err := pool.Query(
		context.Background(),
		`SELECT task_id::text, state, attempt FROM workhorse.fast_task_outcome
		  WHERE task_id = ANY($1::uuid[]) ORDER BY task_id`,
		taskIDs,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var outcomes []fastOutcome
	for rows.Next() {
		var outcome fastOutcome
		if err := rows.Scan(&outcome.TaskID, &outcome.State, &outcome.Attempt); err != nil {
			t.Fatal(err)
		}
		outcomes = append(outcomes, outcome)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return outcomes
}

// runFastWorkerUntil runs the worker until every task has an outcome row.
func runFastWorkerUntil(t *testing.T, pool *pgxpool.Pool, worker *workhorse.Worker, taskIDs []string) {
	t.Helper()
	runContext, stop := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- worker.Run(runContext) }()
	deadline := time.Now().Add(20 * time.Second)
	for len(fastOutcomes(t, pool, taskIDs)) != len(taskIDs) {
		if time.Now().After(deadline) {
			stop()
			<-result
			t.Fatal("worker did not finish the fast tasks in time")
		}
		time.Sleep(20 * time.Millisecond)
	}
	stop()
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func fastRequests(queue, taskType string, count int) []workhorse.EnqueueRequest {
	requests := make([]workhorse.EnqueueRequest, count)
	for sequence := range count {
		requests[sequence] = workhorse.EnqueueRequest{
			Type:    taskType,
			Payload: map[string]any{"sequence": sequence},
			Options: workhorse.EnqueueOptions{Queue: queue},
		}
	}
	return requests
}

func TestFastQueueRejectsFullTierEnqueueFeatures(t *testing.T) {
	pool := fastTierPool(t, "fast-enqueue")
	ctx := context.Background()
	makeFastQueue(t, pool, "go-fast-enqueue")
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-fast-enqueue")

	_, err := queue.Enqueue(ctx, "keyed", map[string]any{}, workhorse.EnqueueOptions{ConcurrencyKey: "tenant-a"})
	var keyed *workhorse.FastTierUnsupportedError
	if !errors.As(err, &keyed) || keyed.Queue != "go-fast-enqueue" || keyed.Feature != "concurrency keys" {
		t.Fatalf("keyed enqueue returned %v", err)
	}
	if !errors.Is(err, workhorse.ErrFastTierUnsupported) {
		t.Fatalf("rejection does not match ErrFastTierUnsupported: %v", err)
	}

	_, err = queue.EnqueueMany(ctx, []workhorse.EnqueueRequest{
		{Type: "plain", Payload: map[string]any{}, Options: workhorse.EnqueueOptions{Queue: "go-fast-enqueue"}},
		{Type: "debounced", Payload: map[string]any{}, Options: workhorse.EnqueueOptions{
			Queue:    "go-fast-enqueue",
			Debounce: &workhorse.Debounce{Key: "k", WindowMS: 1_000, Schedule: workhorse.DebounceReset},
		}},
	})
	var debounced *workhorse.FastTierUnsupportedError
	if !errors.As(err, &debounced) || debounced.Feature != "debounce" || debounced.Ordinal != 2 {
		t.Fatalf("debounced batch returned %v", err)
	}

	taskID, err := queue.Enqueue(ctx, "plain", map[string]any{"n": 1})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool)).GetTask(ctx, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot == nil || snapshot.State != "ready" {
		t.Fatalf("unexpected fast task snapshot %#v", snapshot)
	}
}

func TestQueueTierChangeRequiresAnEmptyQueue(t *testing.T) {
	pool := fastTierPool(t, "fast-tier-change")
	ctx := context.Background()
	executor := workhorse.NewPGXExecutor(pool)
	admin := workhorse.NewAdmin(executor)
	if _, err := workhorse.NewQueue(executor, "go-tier-change").Enqueue(ctx, "live", map[string]any{}); err != nil {
		t.Fatal(err)
	}

	_, err := admin.SetQueueTier(ctx, "go-tier-change", workhorse.QueueTierFast, fastTierAudit())
	var refused *workhorse.FastTierUnsupportedError
	if !errors.As(err, &refused) || refused.Feature != "tier change" {
		t.Fatalf("tier change on a live queue returned %v", err)
	}
	if _, err := admin.SetQueueTier(ctx, "go-tier-change", "medium", fastTierAudit()); err == nil {
		t.Fatal("SetQueueTier accepted an unknown tier")
	}

	if _, err := admin.PurgeQueue(ctx, "go-tier-change", fastTierAudit()); err != nil {
		t.Fatal(err)
	}
	makeFastQueue(t, pool, "go-tier-change")
	recordAttempts := true
	history, err := admin.SetQueueHistory(ctx, "go-tier-change", &recordAttempts, nil)
	if err != nil {
		t.Fatal(err)
	}
	if history != (workhorse.QueueHistory{RecordAttempts: true}) {
		t.Fatalf("unexpected history settings %#v", history)
	}
	tier, err := admin.SetQueueTier(ctx, "go-tier-change", workhorse.QueueTierFull, fastTierAudit())
	if err != nil || tier != workhorse.QueueTierFull {
		t.Fatalf("moving back to the full tier returned %s, %v", tier, err)
	}
}

func TestWorkerRunsFastTasksWithinItsConcurrency(t *testing.T) {
	pool := fastTierPool(t, "fast-run")
	ctx := context.Background()
	makeFastQueue(t, pool, "go-fast-run")
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-fast-run")
	taskIDs, err := queue.EnqueueMany(ctx, fastRequests("go-fast-run", "square", 40))
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-fast-run", WorkerID: "go-fast-runner", Concurrency: 4,
		LeaseDuration: 5 * time.Second, PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	running, peak := 0, 0
	worker.Handle("square", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		sequence := int(payload.(map[string]any)["sequence"].(float64))
		mu.Lock()
		running++
		peak = max(peak, running)
		mu.Unlock()
		time.Sleep(time.Duration(sequence%3) * time.Millisecond)
		mu.Lock()
		running--
		mu.Unlock()
		return map[string]any{"square": sequence * sequence}, nil
	})

	runFastWorkerUntil(t, pool, worker, taskIDs)

	if peak > 4 {
		t.Fatalf("worker ran %d fast tasks at once with a concurrency of 4", peak)
	}
	for _, outcome := range fastOutcomes(t, pool, taskIDs) {
		if outcome.State != "succeeded" || outcome.Attempt != 1 {
			t.Fatalf("unexpected fast outcome %#v", outcome)
		}
	}
	snapshot, err := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool)).GetTask(ctx, taskIDs[7])
	if err != nil {
		t.Fatal(err)
	}
	if snapshot == nil || snapshot.Result.(map[string]any)["square"] != float64(49) {
		t.Fatalf("unexpected fast task snapshot %#v", snapshot)
	}
	var remaining int
	if err := pool.QueryRow(
		ctx, "SELECT count(*) FROM workhorse.fast_task_runtime WHERE queue_name = 'go-fast-run'",
	).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("%d fast runtime rows remain after completion", remaining)
	}
}

func TestFastTaskContextRejectsDurableFeatures(t *testing.T) {
	cases := []struct {
		feature   string
		operation func(*workhorse.HandlerContext) error
	}{
		{"checkpoints", func(handler *workhorse.HandlerContext) error {
			_, err := handler.Checkpoint("step", func() (any, error) { return 1, nil })
			return err
		}},
		{"progress", func(handler *workhorse.HandlerContext) error {
			_, err := handler.SetProgress(map[string]any{"done": 1})
			return err
		}},
		{"durable waits", func(handler *workhorse.HandlerContext) error {
			return handler.Sleep("pause", 10*time.Millisecond)
		}},
		{"signal waits", func(handler *workhorse.HandlerContext) error {
			_, err := handler.WaitForSignal("go")
			return err
		}},
		{"human waits", func(handler *workhorse.HandlerContext) error {
			_, err := handler.WaitForHuman("approve", map[string]any{})
			return err
		}},
		{"child tasks", func(handler *workhorse.HandlerContext) error {
			_, err := handler.RunChild("child", "leaf", map[string]any{})
			return err
		}},
	}
	pool := fastTierPool(t, "fast-guard")
	ctx := context.Background()
	makeFastQueue(t, pool, "go-fast-guard")
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-fast-guard")
	for _, testCase := range cases {
		t.Run(testCase.feature, func(t *testing.T) {
			taskID, err := queue.Enqueue(ctx, "guarded", map[string]any{}, workhorse.EnqueueOptions{MaxAttempts: 1})
			if err != nil {
				t.Fatal(err)
			}
			worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
				Queue: "go-fast-guard", WorkerID: "go-fast-guard", LeaseDuration: 5 * time.Second,
			})
			if err != nil {
				t.Fatal(err)
			}
			var rejection error
			worker.Handle("guarded", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
				rejection = testCase.operation(handler)
				return nil, rejection
			})
			processed, err := worker.RunOnce(ctx)
			if err != nil || !processed {
				t.Fatalf("RunOnce returned processed=%t err=%v", processed, err)
			}
			var unsupported *workhorse.FastTierUnsupportedError
			if !errors.As(rejection, &unsupported) ||
				unsupported.Queue != "go-fast-guard" || unsupported.Feature != testCase.feature {
				t.Fatalf("operation returned %v", rejection)
			}
			snapshot, err := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool)).GetTask(ctx, taskID)
			if err != nil {
				t.Fatal(err)
			}
			if snapshot == nil || snapshot.State != "failed" {
				t.Fatalf("unexpected guarded task snapshot %#v", snapshot)
			}
		})
	}
}

func TestWorkerClaimsAFullTierQueueAfterTheFastClaimIsRefused(t *testing.T) {
	pool := fastTierPool(t, "fast-probe")
	ctx := context.Background()
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-full-queue")
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-full-queue", WorkerID: "go-prober", LeaseDuration: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("full-work", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return map[string]any{"ok": true}, nil
	})
	admin := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool))
	for range 2 {
		taskID, err := queue.Enqueue(ctx, "full-work", map[string]any{})
		if err != nil {
			t.Fatal(err)
		}
		processed, err := worker.RunOnce(ctx)
		if err != nil || !processed {
			t.Fatalf("RunOnce returned processed=%t err=%v", processed, err)
		}
		snapshot, err := admin.GetTask(ctx, taskID)
		if err != nil {
			t.Fatal(err)
		}
		if snapshot == nil || snapshot.State != "succeeded" {
			t.Fatalf("unexpected full-tier snapshot %#v", snapshot)
		}
	}
}

func TestExpiredFastClaimRerunsOnceAndRejectsTheStaleCompletion(t *testing.T) {
	pool := fastTierPool(t, "fast-crash")
	ctx := context.Background()
	makeFastQueue(t, pool, "go-fast-crash")
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-fast-crash")
	taskIDs, err := queue.EnqueueMany(ctx, fastRequests("go-fast-crash", "effect", 12))
	if err != nil {
		t.Fatal(err)
	}
	// A worker that crashed after claiming leaves three leases to expire.
	rows, err := pool.Query(ctx, `SELECT task_id::text, fence_token FROM workhorse.complete_many_and_claim_v1(
		'crashed', '{}', '{}', '{}', 'go-fast-crash', 3, 100) WHERE task_id IS NOT NULL`)
	if err != nil {
		t.Fatal(err)
	}
	type lease struct {
		taskID     string
		fenceToken int64
	}
	var crashed []lease
	for rows.Next() {
		var claimed lease
		if err := rows.Scan(&claimed.taskID, &claimed.fenceToken); err != nil {
			t.Fatal(err)
		}
		crashed = append(crashed, claimed)
	}
	rows.Close()
	if len(crashed) != 3 {
		t.Fatalf("crashed worker claimed %d tasks", len(crashed))
	}
	time.Sleep(200 * time.Millisecond)
	if _, err := pool.Exec(ctx, "SELECT * FROM workhorse.recover_expired_telemetry_v1(100, 0)"); err != nil {
		t.Fatal(err)
	}

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-fast-crash", WorkerID: "go-survivor", Concurrency: 3,
		LeaseDuration: 5 * time.Second, PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	effects := map[string]int{}
	worker.Handle("effect", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		mu.Lock()
		effects[handler.Task.ID]++
		mu.Unlock()
		return map[string]any{"ok": true}, nil
	})
	runFastWorkerUntil(t, pool, worker, taskIDs)

	outcomes := fastOutcomes(t, pool, taskIDs)
	recorded := make([]string, 0, len(outcomes))
	for _, outcome := range outcomes {
		if outcome.State != "succeeded" {
			t.Fatalf("unexpected fast outcome %#v", outcome)
		}
		recorded = append(recorded, outcome.TaskID)
	}
	expected := append([]string{}, taskIDs...)
	sort.Strings(expected)
	if len(recorded) != len(expected) {
		t.Fatalf("recorded %d outcomes for %d tasks", len(recorded), len(expected))
	}
	for index := range expected {
		if recorded[index] != expected[index] || effects[expected[index]] != 1 {
			t.Fatalf("task %s ran %d times", expected[index], effects[expected[index]])
		}
	}

	var accepted []string
	if err := pool.QueryRow(ctx, `SELECT accepted::text[] FROM workhorse.complete_many_and_claim_v1(
		'crashed', $1::uuid[], $2::bigint[], ARRAY['{}'::jsonb], 'go-fast-crash', 0, 30000)`,
		[]string{crashed[0].taskID}, []int64{crashed[0].fenceToken},
	).Scan(&accepted); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx,
		"SELECT count(*) FROM workhorse.fast_task_outcome WHERE task_id = $1::uuid", crashed[0].taskID,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if len(accepted) != 0 || count != 1 {
		t.Fatalf("stale completion accepted=%v outcomes=%d", accepted, count)
	}
}
