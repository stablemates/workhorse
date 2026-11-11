package workhorse_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// durableScriptFixture is a fixture of the kind durable-script. protocol/README.md describes the
// operations of its script and the actions of its steps.
type durableScriptFixture struct {
	ID            string                   `json:"id"`
	TaskType      string                   `json:"taskType"`
	ChildTaskType string                   `json:"childTaskType"`
	ChildQueue    string                   `json:"childQueue"`
	PayloadSQL    string                   `json:"payloadSql"`
	Script        []durableScriptOperation `json:"script"`
	Observe       string                   `json:"observe"`
	Steps         []durableScriptStep      `json:"steps"`
}

type durableScriptOperation struct {
	Op              string                  `json:"op"`
	Key             string                  `json:"key"`
	Name            string                  `json:"name"`
	Value           json.RawMessage         `json:"value"`
	Input           json.RawMessage         `json:"input"`
	DurationMS      int64                   `json:"durationMs"`
	WakeAtField     string                  `json:"wakeAtField"`
	Context         json.RawMessage         `json:"context"`
	Payload         json.RawMessage         `json:"payload"`
	DeadlineField   string                  `json:"deadlineField"`
	RunAtField      string                  `json:"runAtField"`
	Children        []durableScriptChild    `json:"children"`
	Step            *durableScriptOperation `json:"step"`
	OverlapWindowMS int64                   `json:"overlapWindowMs"`
}

type durableScriptChild struct {
	Name    string          `json:"name"`
	Payload json.RawMessage `json:"payload"`
}

type durableScriptStep struct {
	Action               string          `json:"action"`
	Worker               string          `json:"worker"`
	SQL                  string          `json:"sql"`
	Observed             json.RawMessage `json:"observed"`
	HandlerRuns          *int64          `json:"handlerRuns"`
	CheckpointOperations *int64          `json:"checkpointOperations"`
	CaughtSuspensions    *int64          `json:"caughtSuspensions"`
	CompletedScripts     *int64          `json:"completedScripts"`
	ReturnedSuspending   *int64          `json:"returnedSuspendingCalls"`
	// ErrorNames gives the error name of each SDK. It replaces observed.errorName before the
	// comparison.
	ErrorNames map[string]string `json:"errorNames"`
}

type durableScriptCounters struct {
	handlerRuns, checkpointOperations, caughtSuspensions atomic.Int64
	// completedScripts counts handler runs that reached the end of the script. A run that
	// suspends never does.
	completedScripts atomic.Int64
	// returnedSuspending counts timer, wait, and child calls that returned. A call that suspends
	// never returns.
	returnedSuspending atomic.Int64
}

func loadDurableScriptFixture(t *testing.T, id string) durableScriptFixture {
	t.Helper()
	contents, err := os.ReadFile("../protocol/v1/runtime.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []durableScriptFixture
	if err := json.Unmarshal(contents, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		if fixture.ID == id {
			return fixture
		}
	}
	t.Fatalf("runtime fixture %s was not found", id)
	return durableScriptFixture{}
}

func executeWorkerDurableScriptFixture(t *testing.T, fixture workerRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-durable-script")
	runDurableScriptPhase(t, databaseURL, loadDurableScriptFixture(t, fixture.ID), "all")
}

// TestCrossSDKDurableScriptPhase is the entry point of scripts/cross-sdk-replay.ts. It runs one
// phase of a durable-script fixture against a database that the harness owns, and it is skipped
// when the harness did not start it.
func TestCrossSDKDurableScriptPhase(t *testing.T) {
	phase := os.Getenv("WORKHORSE_CROSS_SDK_PHASE")
	if phase == "" {
		t.Skip("scripts/cross-sdk-replay.ts sets WORKHORSE_CROSS_SDK_PHASE")
	}
	databaseURL := os.Getenv("WORKHORSE_CROSS_SDK_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("WORKHORSE_CROSS_SDK_DATABASE_URL is not set")
	}
	fixture := loadDurableScriptFixture(t, os.Getenv("WORKHORSE_CROSS_SDK_FIXTURE"))
	runDurableScriptPhase(t, databaseURL, fixture, phase)
}

// runDurableScriptPhase runs the steps of phase: every step for "all", the steps before handOff
// for "suspend", and the steps after it for "replay". The queue name depends only on the fixture,
// so a phase in another SDK finds the same task.
func runDurableScriptPhase(t *testing.T, databaseURL string, fixture durableScriptFixture, phase string) {
	t.Helper()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	steps := fixture.Steps
	if phase != "all" {
		handOff := -1
		for index, step := range steps {
			if step.Action == "handOff" {
				handOff = index
			}
		}
		switch {
		case handOff < 0:
			t.Fatalf("%s has no handOff step for the %s phase", fixture.ID, phase)
		case phase == "suspend":
			steps = steps[:handOff]
		case phase == "replay":
			steps = steps[handOff+1:]
		default:
			t.Fatalf("unknown phase %q", phase)
		}
	}

	queueName := "runtime-" + fixture.ID
	executor := workhorse.NewPGXExecutor(pool)
	var taskID string
	if phase == "replay" {
		if err := pool.QueryRow(ctx, `SELECT id::text FROM workhorse.task WHERE task_type = $1`, fixture.TaskType).Scan(&taskID); err != nil {
			t.Fatalf("find the %s task: %v", fixture.TaskType, err)
		}
	} else {
		payload := any(map[string]any{})
		if fixture.PayloadSQL != "" {
			var text string
			if err := pool.QueryRow(ctx, fixture.PayloadSQL).Scan(&text); err != nil {
				t.Fatal(err)
			}
			payload = json.RawMessage(text)
		}
		taskID, err = workhorse.NewQueue(executor, queueName).Enqueue(ctx, fixture.TaskType, payload)
		if err != nil {
			t.Fatal(err)
		}
	}

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-" + fixture.ID, Concurrency: 1, DisableRegistry: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	counters := &durableScriptCounters{}
	worker.Handle(fixture.TaskType, func(_ context.Context, payload any, handler *workhorse.HandlerContext) (any, error) {
		return runDurableScript(fixture, payload, handler, counters)
	})
	workers := map[string]*workhorse.Worker{"": worker, "task": worker}
	if fixture.ChildTaskType != "" && fixture.ChildQueue != "" {
		children, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
			Queue: fixture.ChildQueue, WorkerID: "go-" + fixture.ID + "-children", Concurrency: 1,
			DisableRegistry: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		children.Handle(fixture.ChildTaskType, func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
			return map[string]any{"echo": payload}, nil
		})
		workers["child"] = children
	}

	for index, step := range steps {
		where := fmt.Sprintf("%s step %d (%s)", fixture.ID, index+1, step.Action)
		switch step.Action {
		case "run":
			selected, ok := workers[step.Worker]
			if !ok {
				t.Fatalf("%s: the fixture has no %s worker", where, step.Worker)
			}
			drainDurableScriptWorker(t, ctx, selected, where)
		case "sql":
			if _, err := pool.Exec(ctx, step.SQL, taskID); err != nil {
				t.Fatalf("%s: %v", where, err)
			}
		case "handOff":
			counters.handlerRuns.Store(0)
			counters.checkpointOperations.Store(0)
			counters.caughtSuspensions.Store(0)
			counters.completedScripts.Store(0)
			counters.returnedSuspending.Store(0)
		case "expect":
			expectDurableScriptObserved(t, ctx, pool, fixture, taskID, step, counters, where)
		default:
			t.Fatalf("%s: unknown step", where)
		}
	}
}

// drainDurableScriptWorker runs the worker until a claim finds no task. The RunOnce of each SDK
// can claim more than one task, so a step names the work that ends, not a count of claims.
func drainDurableScriptWorker(t *testing.T, ctx context.Context, worker *workhorse.Worker, where string) {
	t.Helper()
	for pass := 0; ; pass++ {
		processed, err := worker.RunOnce(ctx)
		if err != nil {
			t.Fatalf("%s: RunOnce() = %v", where, err)
		}
		if !processed {
			if pass == 0 {
				t.Fatalf("%s: the worker claimed no task", where)
			}
			return
		}
		if pass >= 20 {
			t.Fatalf("%s: the queue did not drain", where)
		}
	}
}

func expectDurableScriptObserved(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	fixture durableScriptFixture,
	taskID string,
	step durableScriptStep,
	counters *durableScriptCounters,
	where string,
) {
	t.Helper()
	var text string
	if err := pool.QueryRow(ctx, fixture.Observe, taskID).Scan(&text); err != nil {
		t.Fatalf("%s: %v", where, err)
	}
	var observed, expected any
	if err := json.Unmarshal([]byte(text), &observed); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(step.Observed, &expected); err != nil {
		t.Fatal(err)
	}
	if step.ErrorNames != nil {
		object, ok := expected.(map[string]any)
		name, named := step.ErrorNames["go"]
		if !ok || !named {
			t.Fatalf("%s: errorNames needs an observed object and a name for go", where)
		}
		object["errorName"] = name
	}
	if !reflect.DeepEqual(observed, expected) {
		t.Fatalf("%s: observed %s, expected %v", where, text, expected)
	}
	for _, counter := range []struct {
		name     string
		expected *int64
		actual   int64
	}{
		{"handlerRuns", step.HandlerRuns, counters.handlerRuns.Load()},
		{"checkpointOperations", step.CheckpointOperations, counters.checkpointOperations.Load()},
		{"caughtSuspensions", step.CaughtSuspensions, counters.caughtSuspensions.Load()},
		{"completedScripts", step.CompletedScripts, counters.completedScripts.Load()},
		{"returnedSuspendingCalls", step.ReturnedSuspending, counters.returnedSuspending.Load()},
	} {
		if counter.expected != nil && *counter.expected != counter.actual {
			t.Fatalf("%s: %s is %d, expected %d", where, counter.name, counter.actual, *counter.expected)
		}
	}
}

func runDurableScript(
	fixture durableScriptFixture,
	payload any,
	handler *workhorse.HandlerContext,
	counters *durableScriptCounters,
) (any, error) {
	counters.handlerRuns.Add(1)
	result := map[string]any{}
	for _, operation := range fixture.Script {
		if operation.Op == "catchSuspension" {
			if _, err := runDurableScriptOperation(fixture, *operation.Step, payload, handler, counters); err != nil {
				// The handler catches the suspension and returns. The worker must suspend the task
				// anyway.
				counters.caughtSuspensions.Add(1)
				return map[string]any{operation.Key: true}, nil
			}
			result[operation.Key] = false
			continue
		}
		value, err := runDurableScriptOperation(fixture, operation, payload, handler, counters)
		if err != nil {
			return nil, err
		}
		if operation.Key != "" {
			result[operation.Key] = value
		}
	}
	counters.completedScripts.Add(1)
	return result, nil
}

// suspendingOperations are the operations that can suspend the task.
var suspendingOperations = map[string]bool{
	"sleep": true, "sleepUntil": true, "waitForSignal": true, "waitForHuman": true,
	"runChild": true,
}

func runDurableScriptOperation(
	fixture durableScriptFixture,
	operation durableScriptOperation,
	payload any,
	handler *workhorse.HandlerContext,
	counters *durableScriptCounters,
) (any, error) {
	value, err := runDurableScriptOperationOnce(fixture, operation, payload, handler, counters)
	if err == nil && suspendingOperations[operation.Op] {
		counters.returnedSuspending.Add(1)
	}
	return value, err
}

func runDurableScriptOperationOnce(
	fixture durableScriptFixture,
	operation durableScriptOperation,
	payload any,
	handler *workhorse.HandlerContext,
	counters *durableScriptCounters,
) (any, error) {
	switch operation.Op {
	case "checkpoint":
		var options []workhorse.CheckpointOptions
		if operation.Input != nil {
			options = append(options, workhorse.CheckpointOptions{Input: decodeScriptJSON(operation.Input)})
		}
		return handler.Checkpoint(operation.Name, func() (any, error) {
			counters.checkpointOperations.Add(1)
			return decodeScriptJSON(operation.Value), nil
		}, options...)
	case "sleep":
		return nil, handler.Sleep(operation.Name, time.Duration(operation.DurationMS)*time.Millisecond)
	case "sleepUntil":
		wakeAt, err := payloadTime(payload, operation.WakeAtField)
		if err != nil {
			return nil, err
		}
		return nil, handler.SleepUntil(operation.Name, wakeAt)
	case "waitForSignal":
		return handler.WaitForSignal(operation.Name)
	case "waitForHuman":
		return handler.WaitForHuman(operation.Name, decodeScriptJSON(operation.Context))
	case "runChild":
		options := workhorse.EnqueueOptions{Queue: fixture.ChildQueue}
		if operation.DeadlineField != "" {
			deadline, err := payloadTime(payload, operation.DeadlineField)
			if err != nil {
				return nil, err
			}
			options.Deadline = &deadline
		}
		if operation.RunAtField != "" {
			runAt, err := payloadTime(payload, operation.RunAtField)
			if err != nil {
				return nil, err
			}
			options.RunAt = &runAt
		}
		return handler.RunChild(operation.Name, fixture.ChildTaskType, decodeScriptJSON(operation.Payload), options)
	case "runChildren":
		requests := make([]workhorse.ChildTaskRequest, 0, len(operation.Children))
		for _, child := range operation.Children {
			requests = append(requests, workhorse.ChildTaskRequest{
				Name: child.Name, Type: fixture.ChildTaskType, Payload: decodeScriptJSON(child.Payload),
				Options: workhorse.EnqueueOptions{Queue: fixture.ChildQueue},
			})
		}
		results, err := handler.RunChildren(requests)
		if err != nil {
			return nil, err
		}
		// The set join counts as returned before the runner reads its outcomes, so a wrong value
		// still counts.
		counters.returnedSuspending.Add(1)
		outcomes := map[string]any{}
		for _, child := range results {
			outcome := map[string]any{"status": child.Outcome.OutcomeStatus()}
			if succeeded, ok := child.Outcome.(workhorse.ChildSucceeded); ok {
				outcome["result"] = succeeded.Result
			}
			outcomes[child.Name] = outcome
		}
		return outcomes, nil
	case "overlappingCheckpoints":
		return overlappingCheckpoints(operation, handler, counters)
	default:
		return nil, fmt.Errorf("unknown durable-script operation %q", operation.Op)
	}
}

// overlappingCheckpoints starts a second call with one name while the operation of the first call
// runs. The operation waits until a second operation starts or the window ends, so a call that does
// not join the call in flight runs the operation again.
func overlappingCheckpoints(
	operation durableScriptOperation,
	handler *workhorse.HandlerContext,
	counters *durableScriptCounters,
) (any, error) {
	started := make(chan struct{})
	var once sync.Once
	checkpointOperation := func() (any, error) {
		ordinal := counters.checkpointOperations.Add(1)
		once.Do(func() { close(started) })
		deadline := time.Now().Add(time.Duration(operation.OverlapWindowMS) * time.Millisecond)
		for counters.checkpointOperations.Load() < 2 && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		return map[string]any{"operation": ordinal}, nil
	}
	type call struct {
		value any
		err   error
	}
	first := make(chan call, 1)
	go func() {
		value, err := handler.Checkpoint(operation.Name, checkpointOperation)
		first <- call{value, err}
	}()
	select {
	case <-started:
	case outcome := <-first:
		// select can take this case when both are ready, so a first call that ended after its
		// operation started is a normal outcome.
		select {
		case <-started:
		default:
			if outcome.err != nil {
				return nil, outcome.err
			}
			return nil, errors.New("the first checkpoint call ended before its operation started")
		}
		first <- outcome
	}
	second, err := handler.Checkpoint(operation.Name, checkpointOperation)
	if err != nil {
		return nil, err
	}
	outcome := <-first
	if outcome.err != nil {
		return nil, outcome.err
	}
	return []any{outcome.value, second}, nil
}

func decodeScriptJSON(raw json.RawMessage) any {
	if raw == nil {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		panic(err)
	}
	return value
}

func payloadTime(payload any, field string) (time.Time, error) {
	fields, ok := payload.(map[string]any)
	if !ok {
		return time.Time{}, fmt.Errorf("the payload is %T, not an object", payload)
	}
	text, ok := fields[field].(string)
	if !ok {
		return time.Time{}, fmt.Errorf("the payload field %s is not text", field)
	}
	return time.Parse(time.RFC3339Nano, text)
}
