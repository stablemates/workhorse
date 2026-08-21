package workhorse_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func TestWorkerClaimsHandlesAndCompletesAJob(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-complete")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker")
	jobID, err := queue.Enqueue(ctx, "report.generate", map[string]any{"reportId": "r-1"})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:         "go-worker",
		WorkerID:      "go-worker-complete",
		LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("report.generate", func(_ context.Context, payload any) (any, error) {
		return map[string]any{"reportId": payload.(map[string]any)["reportId"], "status": "ready"}, nil
	})

	processed, err := worker.RunOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !processed {
		t.Fatal("worker did not claim the enqueued job")
	}

	var state string
	var result []byte
	if err := pool.QueryRow(
		ctx,
		"SELECT state, result FROM workhorse.job_outcome WHERE job_id = $1::uuid",
		jobID,
	).Scan(&state, &result); err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(result, &decoded); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" || decoded["reportId"] != "r-1" || decoded["status"] != "ready" {
		t.Fatalf("unexpected outcome: state=%s result=%#v", state, decoded)
	}
}

func TestWorkerRecordsFailureAndLetsPostgreSQLScheduleTheRetry(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-retry")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker-retry")
	jobID, err := queue.Enqueue(ctx, "delivery.retry", nil, workhorse.EnqueueOptions{
		MaxAttempts: 2,
		RetryPolicy: map[string]any{"type": "fixed", "delayMs": 25},
	})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-worker-retry", WorkerID: "go-worker-retry", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	invocations := 0
	worker.Handle("delivery.retry", func(_ context.Context, _ any) (any, error) {
		invocations++
		if invocations == 1 {
			return nil, errors.New("temporary delivery failure")
		}
		return map[string]any{"delivered": true}, nil
	})

	processed, err := worker.RunOnce(ctx)
	if err != nil || !processed {
		t.Fatalf("first attempt: processed=%t err=%v", processed, err)
	}
	var state string
	var attempt int
	var runAt time.Time
	if err := pool.QueryRow(
		ctx,
		"SELECT state, current_attempt, run_at FROM workhorse.job_runtime WHERE job_id = $1::uuid",
		jobID,
	).Scan(&state, &attempt, &runAt); err != nil {
		t.Fatal(err)
	}
	if state != "scheduled" || attempt != 2 {
		t.Fatalf("PostgreSQL did not schedule the next attempt: state=%s attempt=%d", state, attempt)
	}
	if wait := time.Until(runAt.Add(10 * time.Millisecond)); wait > 0 {
		time.Sleep(wait)
	}

	processed, err = worker.RunOnce(ctx)
	if err != nil || !processed {
		t.Fatalf("second attempt: processed=%t err=%v", processed, err)
	}
	if invocations != 2 {
		t.Fatalf("expected two handler invocations, received %d", invocations)
	}
	var outcome string
	var currentAttempt int
	if err := pool.QueryRow(
		ctx,
		"SELECT state, current_attempt FROM workhorse.job_outcome WHERE job_id = $1::uuid",
		jobID,
	).Scan(&outcome, &currentAttempt); err != nil {
		t.Fatal(err)
	}
	if outcome != "succeeded" || currentAttempt != 2 {
		t.Fatalf("unexpected final outcome: state=%s attempt=%d", outcome, currentAttempt)
	}
}

func TestWorkersCannotClaimTheSameJobConcurrently(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-exclusive")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker-exclusive")
	if _, err := queue.Enqueue(ctx, "exclusive", nil); err != nil {
		t.Fatal(err)
	}
	first, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-worker-exclusive", WorkerID: "go-worker-first", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-worker-exclusive", WorkerID: "go-worker-second", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	first.Handle("exclusive", func(_ context.Context, _ any) (any, error) {
		close(started)
		<-release
		return nil, nil
	})
	firstResult := make(chan error, 1)
	go func() {
		processed, err := first.RunOnce(ctx)
		if err == nil && !processed {
			err = errors.New("first worker did not claim the job")
		}
		firstResult <- err
	}()
	<-started

	processed, err := second.RunOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if processed {
		t.Fatal("second worker claimed a job already owned by the first worker")
	}
	close(release)
	if err := <-firstResult; err != nil {
		t.Fatal(err)
	}
}

func TestWorkerSurfacesRejectedSettlementAsTypedStaleLease(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-stale")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker-stale")
	jobID, err := queue.Enqueue(ctx, "stale", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-worker-stale", WorkerID: "go-worker-stale", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	worker.Handle("stale", func(_ context.Context, _ any) (any, error) {
		close(started)
		<-release
		return map[string]any{"source": "handler"}, nil
	})
	workerResult := make(chan error, 1)
	go func() {
		_, err := worker.RunOnce(ctx)
		workerResult <- err
	}()
	<-started

	var fence int64
	if err := pool.QueryRow(
		ctx,
		"SELECT fence_token FROM workhorse.job_runtime WHERE job_id = $1::uuid",
		jobID,
	).Scan(&fence); err != nil {
		t.Fatal(err)
	}
	var accepted bool
	if err := pool.QueryRow(
		ctx,
		"SELECT workhorse.complete_v1($1::uuid, $2::text, $3::bigint, $4::jsonb)",
		jobID,
		"go-worker-stale",
		fence,
		[]byte(`{"source":"competing-settlement"}`),
	).Scan(&accepted); err != nil {
		t.Fatal(err)
	}
	if !accepted {
		t.Fatal("fault-injection settlement was rejected")
	}
	close(release)
	err = <-workerResult
	if !errors.Is(err, workhorse.ErrStaleLease) {
		t.Fatalf("expected errors.Is stale lease match, received %v", err)
	}
	var stale *workhorse.StaleLeaseError
	if !errors.As(err, &stale) || stale.JobID != jobID {
		t.Fatalf("expected typed stale lease for %s, received %#v", jobID, err)
	}
}
