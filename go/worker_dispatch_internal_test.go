package workhorse

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// These tests drive the dispatch loop with a fake claim and a fake execution, so each claim and
// each execution finishes only when the test says so.

const dispatchTaskType = "dispatch.task"

type fakeClaimCall struct {
	limit   int
	respond chan fakeClaimResponse
}

type fakeClaimResponse struct {
	tasks []ClaimedTask
	err   error
}

type fakeExecution struct {
	task   ClaimedTask
	finish chan error
}

type dispatchHarness struct {
	t            *testing.T
	worker       *Worker
	claims       chan fakeClaimCall
	executions   chan fakeExecution
	results      chan error
	notification chan struct{}
	registry     chan struct{}
	cancel       context.CancelFunc
	outcome      chan dispatchOutcome
	nextTask     int
}

type dispatchOutcome struct {
	active int
	err    error
}

func startDispatch(t *testing.T, options WorkerOptions, paused bool) *dispatchHarness {
	t.Helper()
	worker := newDefaultWorker(t, options)
	worker.Handle(dispatchTaskType, func(context.Context, any, *HandlerContext) (any, error) {
		return nil, nil
	})
	worker.remotelyPaused.Store(paused)
	ctx, cancel := context.WithCancel(context.Background())
	harness := &dispatchHarness{
		t:            t,
		worker:       worker,
		claims:       make(chan fakeClaimCall),
		executions:   make(chan fakeExecution, 100),
		results:      make(chan error, worker.concurrency),
		notification: make(chan struct{}, 1),
		registry:     make(chan struct{}, 1),
		cancel:       cancel,
		outcome:      make(chan dispatchOutcome, 1),
	}
	t.Cleanup(cancel)
	go func() {
		active, err := worker.dispatch(ctx, dispatchEnvironment{
			claim: func(limit int) ([]ClaimedTask, error) {
				respond := make(chan fakeClaimResponse)
				harness.claims <- fakeClaimCall{limit: limit, respond: respond}
				response := <-respond
				return response.tasks, response.err
			},
			execute: func(task ClaimedTask) error {
				finish := make(chan error)
				harness.executions <- fakeExecution{task: task, finish: finish}
				return <-finish
			},
			executionResults: harness.results,
			notificationWake: harness.notification,
			registryWake:     harness.registry,
			listening:        func() bool { return true },
		})
		harness.outcome <- dispatchOutcome{active: active, err: err}
	}()
	return harness
}

func (harness *dispatchHarness) tasks(count int, taskType string) []ClaimedTask {
	tasks := make([]ClaimedTask, 0, count)
	for range count {
		harness.nextTask++
		tasks = append(tasks, ClaimedTask{ID: fmt.Sprintf("task-%d", harness.nextTask), Type: taskType})
	}
	return tasks
}

func (harness *dispatchHarness) expectClaim(limit int) fakeClaimCall {
	harness.t.Helper()
	select {
	case call := <-harness.claims:
		if call.limit != limit {
			harness.t.Fatalf("claim limit: got %d, want %d", call.limit, limit)
		}
		return call
	case <-time.After(2 * time.Second):
		harness.t.Fatalf("no claim for %d slots started", limit)
	}
	return fakeClaimCall{}
}

func (harness *dispatchHarness) expectNoClaim(within time.Duration) {
	harness.t.Helper()
	select {
	case call := <-harness.claims:
		harness.t.Fatalf("unexpected claim for %d slots", call.limit)
	case <-time.After(within):
	}
}

func (harness *dispatchHarness) expectExecutions(count int) []fakeExecution {
	harness.t.Helper()
	executions := make([]fakeExecution, 0, count)
	for range count {
		select {
		case execution := <-harness.executions:
			executions = append(executions, execution)
		case <-time.After(2 * time.Second):
			harness.t.Fatalf("started %d of %d executions", len(executions), count)
		}
	}
	return executions
}

// stop cancels the loop, answers the given in-flight claims with nothing, finishes the given
// executions, and waits for the loop and every execution it left running.
func (harness *dispatchHarness) stop(pending []fakeClaimCall, executions []fakeExecution) error {
	harness.t.Helper()
	harness.cancel()
	for _, call := range pending {
		call.respond <- fakeClaimResponse{}
	}
	for _, execution := range executions {
		execution.finish <- nil
	}
	select {
	case outcome := <-harness.outcome:
		for range outcome.active {
			<-harness.results
		}
		return outcome.err
	case <-time.After(2 * time.Second):
		harness.t.Fatal("dispatch did not return after stop")
	}
	return nil
}

func TestDispatchRefillBatchIsAQuarterOfTheConcurrencyRoundedUp(t *testing.T) {
	for concurrency, want := range map[int]int{1: 1, 4: 1, 5: 2, 8: 2, 16: 4, 100: 25} {
		if got := dispatchRefillBatch(concurrency); got != want {
			t.Errorf("dispatchRefillBatch(%d) = %d, want %d", concurrency, got, want)
		}
	}
}

func TestDispatchOverlapsRefillClaimsInBatches(t *testing.T) {
	harness := startDispatch(t, WorkerOptions{Concurrency: 8}, false)
	harness.expectClaim(8).respond <- fakeClaimResponse{tasks: harness.tasks(8, dispatchTaskType)}
	executions := harness.expectExecutions(8)

	// With no claim in flight, one free slot starts a claim.
	executions[0].finish <- nil
	first := harness.expectClaim(1)
	// One more free slot is below the refill batch of two while that claim is in flight.
	executions[1].finish <- nil
	harness.expectNoClaim(50 * time.Millisecond)
	// Two unreserved free slots reach the batch, so a second claim overlaps the first.
	executions[2].finish <- nil
	second := harness.expectClaim(2)

	if err := harness.stop([]fakeClaimCall{first, second}, executions[3:]); err != nil {
		t.Fatal(err)
	}
}

func TestDispatchRunsTasksAClaimReturnsAfterStop(t *testing.T) {
	harness := startDispatch(t, WorkerOptions{Concurrency: 2}, false)
	harness.expectClaim(2).respond <- fakeClaimResponse{tasks: harness.tasks(1, dispatchTaskType)}
	first := harness.expectExecutions(1)
	inFlight := harness.expectClaim(1)

	harness.cancel()
	// The claimed task holds a lease, so it runs although the loop is stopping.
	inFlight.respond <- fakeClaimResponse{tasks: harness.tasks(1, dispatchTaskType)}
	second := harness.expectExecutions(1)
	if err := harness.stop(nil, append(first, second...)); err != nil {
		t.Fatal(err)
	}
}

func TestDispatchStartsNoClaimWhilePaused(t *testing.T) {
	harness := startDispatch(t, WorkerOptions{Concurrency: 2, PollInterval: 10 * time.Millisecond}, true)
	harness.expectNoClaim(100 * time.Millisecond)

	harness.worker.remotelyPaused.Store(false)
	harness.registry <- struct{}{}
	call := harness.expectClaim(2)
	if err := harness.stop([]fakeClaimCall{call}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestDispatchWaitsThePollIntervalAfterAnEmptyClaim(t *testing.T) {
	pollInterval := 200 * time.Millisecond
	harness := startDispatch(t, WorkerOptions{Concurrency: 2, PollInterval: pollInterval}, false)
	harness.expectClaim(2).respond <- fakeClaimResponse{}
	emptyAt := time.Now()
	call := harness.expectClaim(2)
	if waited := time.Since(emptyAt); waited < pollInterval*9/10 {
		t.Fatalf("claimed again after %s, want the %s poll interval", waited, pollInterval)
	}

	// A notification that arrives during the wait ends it.
	call.respond <- fakeClaimResponse{}
	harness.notification <- struct{}{}
	wokenAt := time.Now()
	call = harness.expectClaim(2)
	if waited := time.Since(wokenAt); waited >= pollInterval*9/10 {
		t.Fatalf("a notification claimed after %s, want before the poll interval", waited)
	}
	if err := harness.stop([]fakeClaimCall{call}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestDispatchTreatsAClaimOfOnlyUnhandledTasksAsEmpty(t *testing.T) {
	harness := startDispatch(t, WorkerOptions{Concurrency: 2, PollInterval: 300 * time.Millisecond}, false)
	harness.expectClaim(2).respond <- fakeClaimResponse{tasks: harness.tasks(1, "dispatch.unhandled")}
	// The unhandled task is handed back once, and the loop backs off instead of claiming again.
	release := harness.expectExecutions(1)
	release[0].finish <- nil
	harness.expectNoClaim(150 * time.Millisecond)
	select {
	case execution := <-harness.executions:
		t.Fatalf("unexpected execution of %s", execution.task.ID)
	default:
	}
	if err := harness.stop(nil, nil); err != nil {
		t.Fatal(err)
	}
}

func TestDispatchReportsAClaimErrorAfterLaunchingItsTasks(t *testing.T) {
	harness := startDispatch(t, WorkerOptions{Concurrency: 2}, false)
	claimErr := fmt.Errorf("claim failed")
	harness.expectClaim(2).respond <- fakeClaimResponse{tasks: harness.tasks(1, dispatchTaskType), err: claimErr}
	executions := harness.expectExecutions(1)
	executions[0].finish <- nil
	select {
	case outcome := <-harness.outcome:
		for range outcome.active {
			<-harness.results
		}
		if outcome.err != claimErr {
			t.Fatalf("dispatch returned %v, want the claim error", outcome.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("dispatch did not stop on the claim error")
	}
}
