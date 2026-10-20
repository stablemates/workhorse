package workhorse_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// The pgx executor decodes a uuid column, and each element of a uuid[] column, as [16]byte. The
// Admin must return canonical UUID text for each task ID it maps.
func TestAdminReturnsUUIDTextForTaskIDsThroughPGX(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-admin-uuid")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	executor := workhorse.NewPGXExecutor(pool)
	queue := workhorse.NewQueue(executor, "admin-uuid")
	admin := workhorse.NewAdmin(executor)

	prerequisiteID, err := queue.Enqueue(ctx, "admin.prerequisite", nil)
	if err != nil {
		t.Fatal(err)
	}
	dependentID, err := queue.Enqueue(ctx, "admin.dependent", nil, workhorse.EnqueueOptions{
		Queue: "admin-uuid-dependent",
		Dependencies: &workhorse.Dependencies{
			PrerequisiteTaskIDs: []string{prerequisiteID},
			OnSuccess:           workhorse.DependencyRelease, OnFailure: workhorse.DependencyCancel,
			OnCancellation: workhorse.DependencyFail,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	parentQueue := workhorse.NewQueue(executor, "admin-uuid-parent")
	parentID, err := parentQueue.Enqueue(ctx, "admin.parent", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "admin-uuid-parent", WorkerID: "admin-uuid-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("admin.parent", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		return handler.RunChild("only", "admin.child", nil, workhorse.EnqueueOptions{Queue: "admin-uuid-child"})
	})
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("create the child: processed=%t err=%v", processed, err)
	}

	dependent := getTask(t, admin, dependentID)
	if dependent.ID != dependentID {
		t.Errorf("ID = %q, expected %q", dependent.ID, dependentID)
	}
	if text(dependent.PrerequisiteTaskID) != prerequisiteID {
		t.Errorf("PrerequisiteTaskID = %q, expected %q", text(dependent.PrerequisiteTaskID), prerequisiteID)
	}
	if !reflect.DeepEqual(dependent.PrerequisiteTaskIDs, []string{prerequisiteID}) {
		t.Errorf("PrerequisiteTaskIDs = %q, expected [%q]", dependent.PrerequisiteTaskIDs, prerequisiteID)
	}

	parent := getTask(t, admin, parentID)
	childID := childOf(t, pool, parentID)
	if !reflect.DeepEqual(parent.ChildTaskIDs, []string{childID}) {
		t.Errorf("ChildTaskIDs = %q, expected [%q]", parent.ChildTaskIDs, childID)
	}
	child := getTask(t, admin, childID)
	if text(child.ParentTaskID) != parentID {
		t.Errorf("ParentTaskID = %q, expected %q", text(child.ParentTaskID), parentID)
	}

	page, err := admin.ListTasks(ctx, workhorse.TaskListQuery{Queue: "admin-uuid-dependent", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != dependentID ||
		!reflect.DeepEqual(page.Items[0].PrerequisiteTaskIDs, []string{prerequisiteID}) {
		t.Errorf("ListTasks items = %#v, expected the dependent with its prerequisite", page.Items)
	}
}

func getTask(t *testing.T, admin *workhorse.Admin, id string) workhorse.TaskListItem {
	t.Helper()
	task, err := admin.GetTask(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if task == nil {
		t.Fatalf("task %s not found", id)
	}
	return task.TaskListItem
}

func childOf(t *testing.T, pool *pgxpool.Pool, parentID string) string {
	t.Helper()
	var childID string
	if err := pool.QueryRow(context.Background(),
		"SELECT child_task_id::text FROM workhorse.task_child WHERE parent_task_id = $1", parentID,
	).Scan(&childID); err != nil {
		t.Fatal(err)
	}
	return childID
}

func text(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}
