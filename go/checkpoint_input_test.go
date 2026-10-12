package workhorse_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

type checkpointInputHarness struct {
	ctx    context.Context
	pool   *pgxpool.Pool
	queue  *workhorse.Queue
	admin  *workhorse.Admin
	worker *workhorse.Worker
}

func newCheckpointInputHarness(t *testing.T, name string) checkpointInputHarness {
	t.Helper()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), name)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	executor := workhorse.NewPGXExecutor(pool)
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-" + name, WorkerID: "go-" + name, Concurrency: 1,
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	return checkpointInputHarness{
		ctx: ctx, pool: pool, queue: workhorse.NewQueue(executor, "go-"+name),
		admin: workhorse.NewAdmin(executor), worker: worker,
	}
}

func (harness checkpointInputHarness) runOnce(t *testing.T) {
	t.Helper()
	if processed, err := harness.worker.RunOnce(harness.ctx); err != nil || !processed {
		t.Fatalf("processed=%t err=%v", processed, err)
	}
}

// wake ends the durable sleep of a suspended task, so the next run replays it.
func (harness checkpointInputHarness) wake(t *testing.T, taskID string) {
	t.Helper()
	if _, err := harness.pool.Exec(
		harness.ctx,
		"UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1 millisecond' WHERE task_id = $1::uuid",
		taskID,
	); err != nil {
		t.Fatal(err)
	}
}

// SM-1262: a deploy changes the input of a stored checkpoint. The replay fails the task at once,
// keeps the current attempt, and does not run the operation again.
func TestAChangedCheckpointInputFailsTheTaskOnReplay(t *testing.T) {
	harness := newCheckpointInputHarness(t, "checkpoint-input-conflict")
	taskID, err := harness.queue.Enqueue(harness.ctx, "charge", nil, workhorse.EnqueueOptions{MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	runs, operations := 0, 0
	harness.worker.Handle("charge", func(
		_ context.Context, _ any, handler *workhorse.HandlerContext,
	) (any, error) {
		// The deploy between the two runs adds a discount before the charge.
		amount := 1000
		if runs > 0 {
			amount = 900
		}
		runs++
		charged, err := handler.Checkpoint("charge-card", func() (any, error) {
			operations++
			return map[string]any{"charged": amount}, nil
		}, workhorse.CheckpointOptions{Input: map[string]any{"amountCents": amount, "currency": "EUR"}})
		if err != nil {
			return nil, err
		}
		if err := handler.Sleep("receipt", time.Hour); err != nil {
			return nil, err
		}
		return charged, nil
	})
	harness.runOnce(t)
	saved, err := harness.admin.GetCheckpoint(harness.ctx, taskID, "charge-card")
	if err != nil || saved == nil {
		t.Fatalf("checkpoint %v, %v", saved, err)
	}
	stored, err := workhorse.CheckpointInputFingerprint(map[string]any{"currency": "EUR", "amountCents": 1000})
	if err != nil {
		t.Fatal(err)
	}
	if saved.InputFingerprint == nil || *saved.InputFingerprint != stored {
		t.Fatalf("stored fingerprint %v, want %s", saved.InputFingerprint, stored)
	}
	harness.wake(t, taskID)
	harness.runOnce(t)

	failed, err := harness.admin.GetTask(harness.ctx, taskID)
	if err != nil || failed == nil {
		t.Fatalf("task %v, %v", failed, err)
	}
	if failed.State != "failed" || failed.CurrentAttempt != 1 {
		t.Fatalf("task is %s at attempt %d; want failed at attempt 1", failed.State, failed.CurrentAttempt)
	}
	if name := failed.Error.(map[string]any)["name"]; name != "CheckpointInputConflictError" {
		t.Fatalf("error name %v, want CheckpointInputConflictError", name)
	}
	if operations != 1 {
		t.Fatalf("the operation ran %d times, want 1", operations)
	}
}

// A NULL fingerprint on either side never conflicts, and key order does not change a fingerprint.
func TestACheckpointInputIsComparedOnlyWhenBothSidesHaveOne(t *testing.T) {
	harness := newCheckpointInputHarness(t, "checkpoint-input-optional")
	taskID, err := harness.queue.Enqueue(harness.ctx, "lookup", nil)
	if err != nil {
		t.Fatal(err)
	}
	runs, operations := 0, 0
	charge := map[string]any{"amountCents": 1000, "currency": "EUR"}
	reordered := struct {
		Currency    string  `json:"currency"`
		AmountCents float64 `json:"amountCents"`
	}{"EUR", 1000}
	other := map[string]any{"amountCents": 900}
	harness.worker.Handle("lookup", func(
		_ context.Context, _ any, handler *workhorse.HandlerContext,
	) (any, error) {
		first := runs == 0
		runs++
		step := func(name string, value int, options ...workhorse.CheckpointOptions) (any, error) {
			return handler.Checkpoint(name, func() (any, error) {
				operations++
				return value, nil
			}, options...)
		}
		if first {
			if _, err := step("plain", 1); err != nil {
				return nil, err
			}
			if _, err := step("charged", 2, workhorse.CheckpointOptions{Input: charge}); err != nil {
				return nil, err
			}
			if _, err := step("same", 3, workhorse.CheckpointOptions{Input: charge}); err != nil {
				return nil, err
			}
			return nil, handler.Sleep("pause", time.Hour)
		}
		var plain, charged, same any
		var err error
		// The stored checkpoint has no input, the call has no input, and the inputs match.
		if plain, err = step("plain", 10, workhorse.CheckpointOptions{Input: other}); err != nil {
			return nil, err
		}
		if charged, err = step("charged", 20); err != nil {
			return nil, err
		}
		if same, err = step("same", 30, workhorse.CheckpointOptions{Input: reordered}); err != nil {
			return nil, err
		}
		return []any{plain, charged, same}, nil
	})
	harness.runOnce(t)
	plain, err := harness.admin.GetCheckpoint(harness.ctx, taskID, "plain")
	if err != nil || plain == nil || plain.InputFingerprint != nil {
		t.Fatalf("plain checkpoint %#v, %v; want no fingerprint", plain, err)
	}
	harness.wake(t, taskID)
	harness.runOnce(t)

	task, err := harness.admin.GetTask(harness.ctx, taskID)
	if err != nil || task == nil {
		t.Fatalf("task %v, %v", task, err)
	}
	result, _ := task.Result.([]any)
	if task.State != "succeeded" || len(result) != 3 ||
		result[0] != 1.0 || result[1] != 2.0 || result[2] != 3.0 {
		t.Fatalf("task is %s with result %#v; want succeeded with [1 2 3]", task.State, task.Result)
	}
	if operations != 3 {
		t.Fatalf("the operations ran %d times, want 3", operations)
	}
}
