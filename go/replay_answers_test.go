package workhorse_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// A second child set was a terminal replay conflict before create_children_v2 named it a limit, so
// it stays terminal. Each other child limit refusal follows the retry policy.
func TestChildLimitRefusalsAndAChangedSet(t *testing.T) {
	cases := []struct {
		shape, state string
		attempt      int
		name         string
	}{
		{"second-set", "failed", 1, "ChildLimitExceededError"},
		{"second-single", "scheduled", 2, "ChildLimitExceededError"},
		{"large-set", "scheduled", 2, "ChildLimitExceededError"},
		{"changed-set", "failed", 1, "ChildConflictError"},
	}
	for _, entry := range cases {
		t.Run(entry.shape, func(t *testing.T) {
			databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-child-limit-"+entry.shape)
			ctx := context.Background()
			pool, err := pgxpool.New(ctx, databaseURL)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-agent-loops")
			parentID, err := queue.Enqueue(ctx, "agent.loop", nil, workhorse.EnqueueOptions{MaxAttempts: 5})
			if err != nil {
				t.Fatal(err)
			}
			parent, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{Queue: "go-agent-loops", WorkerID: "go-agent-worker"})
			if err != nil {
				t.Fatal(err)
			}
			options := workhorse.EnqueueOptions{Queue: "go-agent-tools"}
			value := 1
			parent.Handle("agent.loop", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
				switch entry.shape {
				case "large-set":
					children := make([]workhorse.ChildTaskRequest, 101)
					for index := range children {
						children[index] = workhorse.ChildTaskRequest{Name: fmt.Sprintf("t%d", index), Type: "tool", Payload: 1, Options: options}
					}
					_, err := handler.RunChildren(children)
					return nil, err
				case "second-single":
					if _, err := handler.RunChild("research", "tool", 1, options); err != nil {
						return nil, err
					}
					_, err := handler.RunChild("calculate", "tool", 2, options)
					return nil, err
				}
				if _, err := handler.RunChildren([]workhorse.ChildTaskRequest{{Name: "research", Type: "tool", Payload: value, Options: options}}); err != nil {
					return nil, err
				}
				if entry.shape == "second-set" {
					_, err := handler.RunChildren([]workhorse.ChildTaskRequest{{Name: "calculate", Type: "tool", Payload: 2, Options: options}})
					return nil, err
				}
				return nil, nil
			})
			tools, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{Queue: "go-agent-tools", WorkerID: "go-tool-worker"})
			if err != nil {
				t.Fatal(err)
			}
			tools.Handle("tool", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
				return payload, nil
			})
			runs := []*workhorse.Worker{parent}
			if entry.shape != "large-set" {
				runs = append(runs, tools, parent)
			}
			for index, worker := range runs {
				if index == 2 && entry.shape == "changed-set" {
					value = 2
				}
				if processed, err := worker.RunOnce(ctx); err != nil || !processed {
					t.Fatalf("run %d: processed=%t err=%v", index, processed, err)
				}
			}
			var state, name string
			var attempt int
			if err := pool.QueryRow(ctx,
				`SELECT COALESCE(outcome.state, runtime.state), COALESCE(outcome.current_attempt, runtime.current_attempt),
				        COALESCE(outcome.error, runtime.error)->>'name'
				   FROM workhorse.task task
				   LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
				   LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
				  WHERE task.id = $1`, parentID,
			).Scan(&state, &attempt, &name); err != nil {
				t.Fatal(err)
			}
			if state != entry.state || attempt != entry.attempt || name != entry.name {
				t.Fatalf("parent = %s at attempt %d with %s", state, attempt, name)
			}
		})
	}
}

// pgx sends a time.Time in binary with the nanoseconds cut to microseconds, so a target of
// .1239996 s reaches PostgreSQL as .123999. schedule_wait_v2 compares it as .123, as it compares the
// .123 that TypeScript, Ruby, and the JVM send for the same instant.
func TestSleepUntilSendsMicrosecondsCutFromNanoseconds(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-sleep-until-precision")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-precision")
	taskID, err := queue.Enqueue(ctx, "precision", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{Queue: "go-precision", WorkerID: "go-precision-worker"})
	if err != nil {
		t.Fatal(err)
	}
	target := time.Date(2026, 1, 1, 12, 0, 0, 123999600, time.UTC)
	worker.Handle("precision", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		if err := handler.SleepUntil("follow-up", target); err != nil {
			return nil, err
		}
		// The replay of a millisecond target of another SDK for the same instant elapses too.
		return nil, handler.SleepUntil("follow-up", time.Date(2026, 1, 1, 12, 0, 0, 123000000, time.UTC))
	})
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("processed=%t err=%v", processed, err)
	}
	var stored, state string
	if err := pool.QueryRow(ctx,
		`SELECT to_char(wait.requested_wake_at AT TIME ZONE 'UTC', 'HH24:MI:SS.US'), outcome.state
		   FROM workhorse.task_wait wait JOIN workhorse.task_outcome outcome ON outcome.task_id = wait.task_id
		  WHERE wait.task_id = $1`, taskID,
	).Scan(&stored, &state); err != nil {
		t.Fatal(err)
	}
	if stored != "12:00:00.123999" || state != "succeeded" {
		t.Fatalf("stored %s, state %s", stored, state)
	}
}

func TestTaskGroupCallbackFailureIsInTheSnapshot(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-callback-failure")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var groupID string
	if err := pool.QueryRow(ctx,
		"SELECT DISTINCT group_id::text FROM workhorse.create_task_group_v1($1::jsonb, $2::jsonb, true)",
		`{"onFinish": {"queue": "go-lost-callbacks", "type": "done", "payload": {}, "concurrencyKey": "tenant-7"}}`,
		`[{"queue": "go-lost-members", "type": "work", "payload": {}}]`,
	).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "SELECT workhorse.set_queue_tier_v1('go-lost-callbacks', 'fast', 'go-test', 'test')"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		"SELECT workhorse.complete_v1(task_id, 'go-member-worker', fence_token, 'null'::jsonb) FROM workhorse.claim_v1('go-lost-members', 'go-member-worker', 30000)",
	); err != nil {
		t.Fatal(err)
	}
	var occurredAt time.Time
	if err := pool.QueryRow(ctx,
		"SELECT occurred_at FROM workhorse.task_group_event WHERE group_id = $1 AND event_type = 'callback_failed'", groupID,
	).Scan(&occurredAt); err != nil {
		t.Fatal(err)
	}
	group, err := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "default").GetTaskGroup(ctx, groupID)
	if err != nil {
		t.Fatal(err)
	}
	if group == nil || len(group.Callbacks) != 1 {
		t.Fatalf("group = %#v", group)
	}
	callback := group.Callbacks[0]
	if callback.TaskID != nil || callback.Failure == nil {
		t.Fatalf("callback = %#v", callback)
	}
	failure := *callback.Failure
	if failure.Code != "P1007" ||
		failure.Message != "fast-tier queue go-lost-callbacks does not support concurrency keys" ||
		!failure.FailedAt.Equal(occurredAt) {
		t.Fatalf("failure = %#v, event at %s", failure, occurredAt)
	}
}
