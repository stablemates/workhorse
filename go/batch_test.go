package workhorse_test

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

type batchRuntimeFixture struct {
	ID                   string                    `json:"id"`
	TaskType             string                    `json:"taskType"`
	Concurrency          int                       `json:"concurrency"`
	BatchMaxSize         int                       `json:"batchMaxSize"`
	Tasks                []batchRuntimeTask        `json:"tasks"`
	ExpectedHandlerOrder []string                  `json:"expectedHandlerOrder"`
	ExpectedAfterFirst   map[string]batchTaskState `json:"expectedAfterFirstRun"`
	ExpectedAfterSecond  map[string]batchTaskState `json:"expectedAfterSecondRun"`
}

type batchRuntimeTask struct {
	Key         string `json:"key"`
	Priority    int    `json:"priority"`
	MaxAttempts int    `json:"maxAttempts"`
	Outcome     string `json:"outcome"`
}

type batchTaskState struct {
	State   string `json:"state"`
	Attempt int    `json:"attempt"`
}

func executeWorkerBatchFixture(t *testing.T, fixture batchRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-batch-fixture")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-batch-fixture"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskIDs := make(map[string]string, len(fixture.Tasks))
	for _, task := range fixture.Tasks {
		taskID, err := queue.Enqueue(ctx, fixture.TaskType, map[string]any{
			"key": task.Key, "outcome": task.Outcome,
		}, workhorse.EnqueueOptions{
			Priority: task.Priority, MaxAttempts: task.MaxAttempts,
			RetryPolicy: map[string]any{"type": "fixed", "delayMs": 0},
		})
		if err != nil {
			t.Fatal(err)
		}
		taskIDs[task.Key] = taskID
	}

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-batch-fixture", Concurrency: fixture.Concurrency,
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	var handlerOrder []string
	var stop context.CancelFunc
	worker.HandleBatch(fixture.TaskType, workhorse.BatchHandlerOptions{
		MaxSize: fixture.BatchMaxSize, Linger: time.Second,
	}, func(items []workhorse.BatchHandlerItem) []workhorse.BatchHandlerOutcome {
		outcomes := make([]workhorse.BatchHandlerOutcome, len(items))
		for index, item := range items {
			payload := item.Payload.(map[string]any)
			key := payload["key"].(string)
			handlerOrder = append(handlerOrder, key)
			if payload["outcome"] == "succeed" || item.Context.Task.Attempt > 1 {
				outcomes[index] = workhorse.BatchSucceeded{Result: map[string]any{"attempt": item.Context.Task.Attempt}}
			} else {
				outcomes[index] = workhorse.BatchFailed{Error: fmt.Errorf("%s on attempt %d", key, item.Context.Task.Attempt)}
			}
		}
		stop()
		return outcomes
	})

	for run, expected := range []map[string]batchTaskState{
		fixture.ExpectedAfterFirst,
		fixture.ExpectedAfterSecond,
	} {
		runContext, cancel := context.WithCancel(ctx)
		stop = cancel
		if err := worker.Run(runContext); err != nil {
			t.Fatalf("run %d: %v", run+1, err)
		}
		assertBatchTaskStates(t, ctx, pool, taskIDs, expected)
	}
	if !reflect.DeepEqual(handlerOrder[:len(fixture.ExpectedHandlerOrder)], fixture.ExpectedHandlerOrder) {
		t.Fatalf("unexpected first batch order: %v", handlerOrder)
	}
	assertBatchAttemptCounts(t, ctx, pool, taskIDs, map[string]int{"succeed": 1, "retry": 2, "fail": 1})
}

func TestWorkerRecoversBatchHandlerPanicForEveryMember(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-batch-panic")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-batch-panic"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskIDs := make(map[string]string, 3)
	for _, key := range []string{"first", "second", "following"} {
		taskID, err := queue.Enqueue(ctx, "batch.panic", map[string]any{"key": key}, workhorse.EnqueueOptions{MaxAttempts: 1})
		if err != nil {
			t.Fatal(err)
		}
		taskIDs[key] = taskID
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-batch-panic", Concurrency: 2,
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	runContext, stop := context.WithCancel(ctx)
	invocations := 0
	worker.HandleBatch("batch.panic", workhorse.BatchHandlerOptions{
		MaxSize: 2, Linger: time.Second,
	}, func(items []workhorse.BatchHandlerItem) []workhorse.BatchHandlerOutcome {
		invocations++
		if invocations == 1 {
			panic("provider batch failed")
		}
		stop()
		outcomes := make([]workhorse.BatchHandlerOutcome, len(items))
		for index := range items {
			outcomes[index] = workhorse.BatchSucceeded{Result: nil}
		}
		return outcomes
	})

	if err := worker.Run(runContext); err != nil {
		t.Fatal(err)
	}
	assertBatchTaskStates(t, ctx, pool, taskIDs, map[string]batchTaskState{
		"first": {State: "failed", Attempt: 1}, "second": {State: "failed", Attempt: 1},
		"following": {State: "succeeded", Attempt: 1},
	})
	var dispatched, failed int
	if err := pool.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE event_type = 'batch_dispatched'),
		count(*) FILTER (WHERE event_type = 'batch_failed')
		FROM workhorse.task_event WHERE task_id = ANY($1::uuid[])`, []string{taskIDs["first"], taskIDs["second"]}).Scan(&dispatched, &failed); err != nil {
		t.Fatal(err)
	}
	if dispatched != 2 || failed != 2 {
		t.Fatalf("unexpected batch evidence: dispatched=%d failed=%d", dispatched, failed)
	}
}

func loadBatchRuntimeFixture(t *testing.T, id string) batchRuntimeFixture {
	t.Helper()
	fixtures := readFixture[[]batchRuntimeFixture](t, "runtime.json")
	for _, fixture := range fixtures {
		if fixture.ID == id {
			return fixture
		}
	}
	t.Fatalf("runtime fixture %s was not found", id)
	return batchRuntimeFixture{}
}

func assertBatchTaskStates(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	taskIDs map[string]string,
	expected map[string]batchTaskState,
) {
	t.Helper()
	for key, want := range expected {
		var state string
		var attempt int
		err := pool.QueryRow(ctx, `SELECT state, current_attempt FROM (
			SELECT task_id, state, current_attempt FROM workhorse.task_runtime
			UNION ALL
			SELECT task_id, state, current_attempt FROM workhorse.task_outcome
		) tasks WHERE task_id = $1::uuid`, taskIDs[key]).Scan(&state, &attempt)
		if err != nil {
			t.Fatal(err)
		}
		if state != want.State || attempt != want.Attempt {
			t.Errorf("%s: expected state=%s attempt=%d, received state=%s attempt=%d", key, want.State, want.Attempt, state, attempt)
		}
	}
}

func assertBatchAttemptCounts(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	taskIDs map[string]string,
	expected map[string]int,
) {
	t.Helper()
	for key, want := range expected {
		var attempts int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM workhorse.attempt_history WHERE task_id = $1::uuid", taskIDs[key]).Scan(&attempts); err != nil {
			t.Fatal(err)
		}
		if attempts != want {
			t.Errorf("%s: expected %d attempts, received %d", key, want, attempts)
		}
	}
}
