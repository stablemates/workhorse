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
		{Name: "second", Result: map[string]any{"value": float64(20)}},
		{Name: "first", Result: map[string]any{"value": float64(10)}},
	}
	if !reflect.DeepEqual(joined, expected) {
		t.Fatalf("joined results lost creation order: %#v", joined)
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
