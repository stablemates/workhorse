package workhorse_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func requiredFieldSchema(field string) map[string]any {
	return map[string]any{
		"type":       "object",
		"required":   []any{field},
		"properties": map[string]any{field: map[string]any{"type": "integer"}},
	}
}

func syncChildContract(
	t *testing.T,
	queue *workhorse.Queue,
	taskType string,
	current string,
	versions map[string]workhorse.TaskContractVersion,
) {
	t.Helper()
	if err := queue.SyncContracts(context.Background(), map[string]workhorse.TaskTypeContracts{
		taskType: {CurrentVersion: current, Versions: versions},
	}); err != nil {
		t.Fatal(err)
	}
}

func assertChildContractVersions(t *testing.T, pool *pgxpool.Pool, parentID string, expected ...string) {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT task.contract_version
		FROM workhorse.task_child child
		JOIN workhorse.task task ON task.id = child.child_task_id
		WHERE child.parent_task_id = $1
		ORDER BY child.child_name`, parentID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var received []string
	for rows.Next() {
		var version *string
		if err := rows.Scan(&version); err != nil {
			t.Fatal(err)
		}
		if version == nil {
			received = append(received, "<nil>")
		} else {
			received = append(received, *version)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(received) != len(expected) {
		t.Fatalf("child contract versions: expected %v, received %v", expected, received)
	}
	for index := range expected {
		if received[index] != expected[index] {
			t.Fatalf("child contract versions: expected %v, received %v", expected, received)
		}
	}
}

func TestGoParentCreatesContractedChildren(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-contracted-children")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-contracted-parent")
	syncChildContract(t, queue, "go.contracted-child", "v1", map[string]workhorse.TaskContractVersion{
		"v1": {PayloadSchema: requiredFieldSchema("value"), MaxPayloadBytes: 4096, SensitivePayloadKeys: []string{"secret"}},
	})
	parentIDs := make(map[string]string)
	for _, parentType := range []string{"go.single-parent", "go.settled-parent", "go.all-parent"} {
		parentID, err := queue.Enqueue(ctx, parentType, nil)
		if err != nil {
			t.Fatal(err)
		}
		parentIDs[parentType] = parentID
	}
	parent, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-contracted-parent", WorkerID: "go-contracted-parent-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	options := workhorse.EnqueueOptions{Queue: "go-contracted-child"}
	parent.Handle("go.single-parent", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		return handler.RunChild("child", "go.contracted-child", map[string]any{"value": 1}, options)
	})
	parent.Handle("go.settled-parent", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		return handler.RunChildren([]workhorse.ChildTaskRequest{
			{Name: "child", Type: "go.contracted-child", Payload: map[string]any{"value": 2}, Options: options},
		})
	})
	parent.Handle("go.all-parent", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		return handler.RunChildrenAll([]workhorse.ChildTaskRequest{
			{Name: "child", Type: "go.contracted-child", Payload: map[string]any{"value": 3}, Options: options},
		})
	})
	child, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-contracted-child", WorkerID: "go-contracted-child-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	child.Handle("go.contracted-child", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		return payload, nil
	})

	for _, phase := range []struct {
		name   string
		worker *workhorse.Worker
	}{{"create children", parent}, {"complete children", child}, {"join children", parent}} {
		for step := range 3 {
			if processed, err := phase.worker.RunOnce(ctx); err != nil || !processed {
				t.Fatalf("%s %d: processed=%t err=%v", phase.name, step, processed, err)
			}
		}
	}
	for parentType, parentID := range parentIDs {
		assertChildContractVersions(t, pool, parentID, "v1")
		var payloadLimit int
		var redactKeys []string
		if err := pool.QueryRow(ctx, `
			SELECT task.payload_max_bytes, task.payload_redact_keys
			FROM workhorse.task_child child
			JOIN workhorse.task task ON task.id = child.child_task_id
			WHERE child.parent_task_id = $1`, parentID,
		).Scan(&payloadLimit, &redactKeys); err != nil {
			t.Fatal(err)
		}
		if payloadLimit != 4096 || len(redactKeys) != 1 || redactKeys[0] != "secret" {
			t.Fatalf("%s child did not take its contract limits: limit=%d keys=%v", parentType, payloadLimit, redactKeys)
		}
		var state string
		if err := pool.QueryRow(ctx, "SELECT state FROM workhorse.task_outcome WHERE task_id = $1", parentID).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state != "succeeded" {
			t.Fatalf("%s did not succeed: %s", parentType, state)
		}
	}
}

func TestGoParentRejectsAnInvalidContractedChildPayload(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-invalid-contracted-child")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-invalid-contract-parent")
	syncChildContract(t, queue, "go.contracted-child", "v1", map[string]workhorse.TaskContractVersion{
		"v1": {PayloadSchema: requiredFieldSchema("value")},
	})
	parentID, err := queue.Enqueue(ctx, "go.invalid-contract-parent", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	parent, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-invalid-contract-parent", WorkerID: "go-invalid-contract-parent-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	returned := make(chan error, 2)
	parent.Handle("go.invalid-contract-parent", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		_, single := handler.RunChild("single", "go.contracted-child", map[string]any{"other": 1})
		returned <- single
		_, set := handler.RunChildren([]workhorse.ChildTaskRequest{
			{Name: "valid", Type: "go.contracted-child", Payload: map[string]any{"value": 1}},
			{Name: "invalid", Type: "go.contracted-child", Payload: map[string]any{"other": 1}},
		})
		returned <- set
		return nil, set
	})
	if processed, err := parent.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("parent: processed=%t err=%v", processed, err)
	}
	for _, label := range []string{"RunChild", "RunChildren"} {
		var validation *workhorse.TaskContractValidationError
		if err := <-returned; !errors.As(err, &validation) ||
			validation.TaskType != "go.contracted-child" || validation.Version != "v1" {
			t.Fatalf("%s returned %#v, expected a payload contract validation error", label, err)
		}
	}
	assertChildCount(t, pool, parentID, 0)
}

func TestGoParentReplaysContractedChildrenAfterTheContractMoves(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-replayed-contracted-children")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-replay-contract-parent")
	v1 := workhorse.TaskContractVersion{PayloadSchema: requiredFieldSchema("value")}
	syncChildContract(t, queue, "go.rejecting-child", "v1", map[string]workhorse.TaskContractVersion{"v1": v1})
	syncChildContract(t, queue, "go.limited-child", "v1", map[string]workhorse.TaskContractVersion{"v1": v1})
	parentIDs := make(map[string]string)
	for _, childType := range []string{"go.rejecting-child", "go.limited-child"} {
		parentID, err := queue.Enqueue(ctx, "go.replay-contract-parent", map[string]any{"childType": childType})
		if err != nil {
			t.Fatal(err)
		}
		parentIDs[childType] = parentID
	}
	parent, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-replay-contract-parent", WorkerID: "go-replay-contract-parent-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	options := workhorse.EnqueueOptions{Queue: "go-replay-contract-child"}
	parent.Handle("go.replay-contract-parent", func(_ context.Context, payload any, handler *workhorse.HandlerContext) (any, error) {
		childType := payload.(map[string]any)["childType"].(string)
		return handler.RunChildrenAll([]workhorse.ChildTaskRequest{
			{Name: "child", Type: childType, Payload: map[string]any{"value": 1}, Options: options},
		})
	})
	child, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-replay-contract-child", WorkerID: "go-replay-contract-child-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	for childType := range parentIDs {
		child.Handle(childType, func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
			return payload, nil
		})
	}

	for step := range 2 {
		if processed, err := parent.RunOnce(ctx); err != nil || !processed {
			t.Fatalf("create child %d: processed=%t err=%v", step, processed, err)
		}
	}
	// v2 rejects one accepted payload and changes the other child's stamped payload limit.
	syncChildContract(t, queue, "go.rejecting-child", "v2", map[string]workhorse.TaskContractVersion{
		"v1": v1, "v2": {PayloadSchema: requiredFieldSchema("renamed")},
	})
	syncChildContract(t, queue, "go.limited-child", "v2", map[string]workhorse.TaskContractVersion{
		"v1": v1, "v2": {PayloadSchema: requiredFieldSchema("value"), MaxPayloadBytes: 2048},
	})
	for step := range 2 {
		if processed, err := child.RunOnce(ctx); err != nil || !processed {
			t.Fatalf("complete child %d: processed=%t err=%v", step, processed, err)
		}
	}
	for step := range 2 {
		if processed, err := parent.RunOnce(ctx); err != nil || !processed {
			t.Fatalf("join child %d: processed=%t err=%v", step, processed, err)
		}
	}

	for childType, parentID := range parentIDs {
		assertChildCount(t, pool, parentID, 1)
		assertChildContractVersions(t, pool, parentID, "v1")
		var state string
		if err := pool.QueryRow(ctx, "SELECT state FROM workhorse.task_outcome WHERE task_id = $1", parentID).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state != "succeeded" {
			t.Fatalf("parent of %s did not succeed after the contract moved: %s", childType, state)
		}
	}
}
