package workhorse_test

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func TestGoParentJoinsTypeScriptChildrenInCreationOrderWithoutDuplicatingThem(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-child-interop")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-child-parent"
	childQueue := "typescript-child"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	parentID, err := queue.Enqueue(ctx, "go.parent", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-child-parent-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	activations := 0
	var joined []workhorse.ChildResult
	worker.Handle("go.parent", func(
		_ context.Context,
		_ any,
		handler *workhorse.HandlerContext,
	) (any, error) {
		activations++
		results, err := handler.CreateChildren([]workhorse.ChildJobRequest{
			{Name: "second", Type: "typescript.child", Payload: map[string]any{"value": 2}, Options: workhorse.EnqueueOptions{Queue: childQueue}},
			{Name: "first", Type: "typescript.child", Payload: map[string]any{"value": 1}, Options: workhorse.EnqueueOptions{Queue: childQueue}},
		})
		if err != nil {
			return nil, err
		}
		joined = results
		return results, nil
	})

	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("create children: processed=%t err=%v", processed, err)
	}
	assertChildCount(t, pool, parentID, 2)
	processChildrenWithTypeScript(t, databaseURL, childQueue)
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("join children: processed=%t err=%v", processed, err)
	}

	assertChildCount(t, pool, parentID, 2)
	if activations != 2 {
		t.Fatalf("expected two parent activations, received %d", activations)
	}
	expected := []workhorse.ChildResult{
		{Name: "second", Outcome: workhorse.ChildSucceeded{Result: map[string]any{"value": float64(20)}}},
		{Name: "first", Outcome: workhorse.ChildSucceeded{Result: map[string]any{"value": float64(10)}}},
	}
	if !reflect.DeepEqual(joined, expected) {
		t.Fatalf("joined results lost creation order: %#v", joined)
	}
}

func TestGoParentReceivesMixedSettledOutcomes(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-child-settled")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-settled-parents")
	parentID, err := queue.Enqueue(ctx, "go.settled-parent", nil)
	if err != nil {
		t.Fatal(err)
	}
	parent, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-settled-parents", WorkerID: "go-settled-parent-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	var joined []workhorse.ChildResult
	parent.Handle("go.settled-parent", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		results, err := handler.CreateChildren([]workhorse.ChildJobRequest{
			{Name: "accepted", Type: "go.settled-success", Options: workhorse.EnqueueOptions{Queue: "go-settled-success", MaxAttempts: 1}},
			{Name: "rejected", Type: "go.settled-failure", Options: workhorse.EnqueueOptions{Queue: "go-settled-failure", MaxAttempts: 1}},
			{Name: "skipped", Type: "go.settled-canceled", Options: workhorse.EnqueueOptions{Queue: "go-settled-canceled", MaxAttempts: 1}},
		})
		if err == nil {
			joined = results
		}
		return results, err
	})
	if processed, err := parent.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("create children: processed=%t err=%v", processed, err)
	}

	success, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{Queue: "go-settled-success", WorkerID: "go-settled-success-worker"})
	if err != nil {
		t.Fatal(err)
	}
	success.Handle("go.settled-success", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return map[string]any{"value": 1}, nil
	})
	failure, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{Queue: "go-settled-failure", WorkerID: "go-settled-failure-worker"})
	if err != nil {
		t.Fatal(err)
	}
	failure.Handle("go.settled-failure", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, errors.New("rejected")
	})
	if processed, err := success.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("complete child: processed=%t err=%v", processed, err)
	}
	if processed, err := failure.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("fail child: processed=%t err=%v", processed, err)
	}
	var canceledID string
	if err := pool.QueryRow(ctx,
		"SELECT child_job_id FROM workhorse.job_child WHERE parent_job_id = $1 AND child_name = $2",
		parentID, "skipped",
	).Scan(&canceledID); err != nil {
		t.Fatal(err)
	}
	if result, err := queue.Cancel(ctx, canceledID, workhorse.CancellationRequest{}); err != nil || result.Status != workhorse.CancelCanceled {
		t.Fatalf("cancel child: result=%#v err=%v", result, err)
	}
	if processed, err := parent.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("join children: processed=%t err=%v", processed, err)
	}
	if len(joined) != 3 || joined[0].Name != "accepted" || joined[1].Name != "rejected" || joined[2].Name != "skipped" {
		t.Fatalf("settled results lost request order: %#v", joined)
	}
	if _, ok := joined[0].Outcome.(workhorse.ChildSucceeded); !ok {
		t.Fatalf("expected success outcome: %#v", joined[0])
	}
	if _, ok := joined[1].Outcome.(workhorse.ChildFailed); !ok {
		t.Fatalf("expected failure outcome: %#v", joined[1])
	}
	if _, ok := joined[2].Outcome.(workhorse.ChildCanceled); !ok {
		t.Fatalf("expected cancellation outcome: %#v", joined[2])
	}
}

func TestGoCreateChildrenAllPropagatesFailure(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-child-all-success")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-all-success-parent")
	parentID, err := queue.Enqueue(ctx, "go.all-success-parent", nil)
	if err != nil {
		t.Fatal(err)
	}
	parent, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{Queue: "go-all-success-parent", WorkerID: "go-all-success-parent-worker"})
	if err != nil {
		t.Fatal(err)
	}
	parent.Handle("go.all-success-parent", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		return handler.CreateChildrenAll([]workhorse.ChildJobRequest{{Name: "rejected", Type: "go.all-success-child", Options: workhorse.EnqueueOptions{Queue: "go-all-success-child", MaxAttempts: 1}}})
	})
	child, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{Queue: "go-all-success-child", WorkerID: "go-all-success-child-worker"})
	if err != nil {
		t.Fatal(err)
	}
	child.Handle("go.all-success-child", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, errors.New("rejected")
	})
	if processed, err := parent.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("create child: processed=%t err=%v", processed, err)
	}
	if processed, err := child.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("fail child: processed=%t err=%v", processed, err)
	}
	var state string
	if err := pool.QueryRow(ctx, "SELECT state FROM workhorse.job_outcome WHERE job_id = $1", parentID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "failed" {
		t.Fatalf("all-success failure did not propagate: %s", state)
	}
}

func TestGoParentCreatesAndJoinsOneChild(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-single-child")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-single-parent")
	parentID, err := queue.Enqueue(ctx, "go.single-parent", nil)
	if err != nil {
		t.Fatal(err)
	}
	parent, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-single-parent", WorkerID: "go-single-parent-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	parent.Handle("go.single-parent", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		return handler.CreateChild(
			"only", "go.single-child", map[string]any{"value": 4},
			workhorse.EnqueueOptions{Queue: "go-single-child"},
		)
	})
	child, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-single-child", WorkerID: "go-single-child-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	child.Handle("go.single-child", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		return payload, nil
	})

	if processed, err := parent.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("create child: processed=%t err=%v", processed, err)
	}
	if processed, err := child.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("complete child: processed=%t err=%v", processed, err)
	}
	if processed, err := parent.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("join child: processed=%t err=%v", processed, err)
	}
	assertChildCount(t, pool, parentID, 1)

	var result any
	if err := pool.QueryRow(ctx, "SELECT result FROM workhorse.job_outcome WHERE job_id = $1", parentID).Scan(&result); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result, map[string]any{"value": float64(4)}) {
		t.Fatalf("unexpected single-child result: %#v", result)
	}
}

func TestCreateChildrenReturnsTypedJoinedResultLimitError(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-child-result-limit")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	request, err := json.Marshal([]map[string]any{{
		"queue": "go-child-result-limit", "type": "go.result-limit", "payload": nil,
		"resultMaxBytes": 1, "maxAttempts": 1,
	}})
	if err != nil {
		t.Fatal(err)
	}
	var parentID string
	if err := pool.QueryRow(ctx,
		"SELECT job_id FROM workhorse.enqueue_many_v1($1::jsonb)", request,
	).Scan(&parentID); err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-child-result-limit", WorkerID: "go-child-result-limit-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	returned := make(chan error, 1)
	worker.Handle("go.result-limit", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		_, err := handler.CreateChildren(nil)
		returned <- err
		return nil, err
	})
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("process result limit: processed=%t err=%v", processed, err)
	}

	var limitError *workhorse.ChildResultLimitExceededError
	err = <-returned
	if !errors.As(err, &limitError) || limitError.ParentJobID != parentID || limitError.ResultBytes != 2 || limitError.ResultLimitBytes != 1 {
		t.Fatalf("unexpected joined-result limit error: %#v", err)
	}
}

func assertChildCount(t *testing.T, pool *pgxpool.Pool, parentID string, expected int) {
	t.Helper()
	var count int
	if err := pool.QueryRow(
		context.Background(), "SELECT count(*) FROM workhorse.job_child WHERE parent_job_id = $1", parentID,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != expected {
		t.Fatalf("expected %d retained children, received %d", expected, count)
	}
}

func processChildrenWithTypeScript(t *testing.T, databaseURL, queueName string) {
	t.Helper()
	command := exec.Command(
		"pnpm", "exec", "tsx", "typescript/core/test/go-interop-child-worker.ts", databaseURL, queueName,
	)
	command.Dir = ".."
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("TypeScript child worker failed: %v: %s", err, output)
	}
}
