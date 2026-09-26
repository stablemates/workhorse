package workhorse

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// These tests drive the dispatch loop with a fake claim and a fake execution, so each claim and
// each execution finishes only when the test says so.

const dispatchTaskType = "dispatch.task"

type fakeClaimCall struct {
	// limit is how many tasks the claim may return: at most fastLimit from a fast-tier queue.
	limit   int
	respond chan fakeClaimResponse
}

// dispatchTier is the tier the harness's single queue answers on. A full-tier queue refuses the
// fast claim, so the worker claims the whole limit; a fast-tier queue takes only fastLimit.
type dispatchTier int

const (
	fullTierQueue dispatchTier = iota
	fastTierQueue
)

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
	results      chan executionResult
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
	return startDispatchOn(t, options, paused, fullTierQueue)
}

func startDispatchOn(t *testing.T, options WorkerOptions, paused bool, tier dispatchTier) *dispatchHarness {
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
		results:      make(chan executionResult, 2*worker.concurrency),
		notification: make(chan struct{}, 1),
		registry:     make(chan struct{}, 1),
		cancel:       cancel,
		outcome:      make(chan dispatchOutcome, 1),
	}
	t.Cleanup(cancel)
	go func() {
		active, err := worker.dispatch(ctx, dispatchEnvironment{
			claim: func(limit int, fastLimit int) ([]ClaimedTask, error) {
				if tier == fastTierQueue {
					limit = min(limit, fastLimit)
					worker.markFastTier(worker.queues[0])
				} else {
					worker.markFullTier(worker.queues[0])
				}
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

// reserve asks the loop for a fused completion claim the way writeFastCompletion does.
func (harness *dispatchHarness) reserve(execution fakeExecution) *completionReservation {
	return harness.worker.completionClaims.Load().reserve(execution.task)
}

func expectCohorts(t *testing.T, executions []fakeExecution, want ...int) {
	t.Helper()
	for index, execution := range executions {
		if got := execution.task.slot.cohort; got != want[index] {
			t.Fatalf("execution %d runs in cohort %d, want %d", index, got, want[index])
		}
	}
}

func TestDefaultDispatchCohortsGrowWithTheConcurrency(t *testing.T) {
	for concurrency, want := range map[int]int{
		1: 1, 4: 1, 7: 1, 8: 2, 16: 2, 17: 3, 32: 4, 64: 8, 65: 8, 100: 8,
	} {
		if got := defaultDispatchCohorts(concurrency, 100); got != want {
			t.Errorf("defaultDispatchCohorts(%d) = %d, want %d", concurrency, got, want)
		}
	}
}

func TestDefaultDispatchCohortsKeepOneSpareConnectionEach(t *testing.T) {
	for _, expectation := range []struct{ concurrency, spare, want int }{
		{64, 3, 3},
		{64, 1, 1},
		{16, 0, 1},
	} {
		if got := defaultDispatchCohorts(expectation.concurrency, expectation.spare); got != expectation.want {
			t.Errorf(
				"defaultDispatchCohorts(%d, %d) = %d, want %d",
				expectation.concurrency, expectation.spare, got, expectation.want,
			)
		}
	}
}

func TestWorkerCapsOnlyTheDefaultCohortsAtThePool(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{Concurrency: 64})
	// Shared heartbeats leave the listener as the only connection the worker holds itself.
	spare := int(worker.pool.Config().MaxConns) - 1
	if want := min(8, spare); worker.cohorts != want {
		t.Errorf("default cohorts at concurrency 64: got %d, want %d", worker.cohorts, want)
	}
	explicit := newDefaultWorker(t, WorkerOptions{Concurrency: 64, Cohorts: 64})
	if explicit.cohorts != 64 {
		t.Errorf("explicit cohorts: got %d, want 64", explicit.cohorts)
	}
}

func TestWorkerRejectsCohortsOutsideOneThroughTheConcurrency(t *testing.T) {
	for _, cohorts := range []int{-1, 5} {
		_, err := NewWorker(unconnectedPool(t), WorkerOptions{
			Queue: "defaults", Concurrency: 4, Cohorts: cohorts,
		})
		if err == nil || err.Error() != workerCohortsRangeMessage {
			t.Errorf("cohorts %d: got %v, want %q", cohorts, err, workerCohortsRangeMessage)
		}
	}
}

func TestDispatchFillsOneCohortPerClaimOnAFastQueue(t *testing.T) {
	harness := startDispatchOn(t, WorkerOptions{Concurrency: 5, Cohorts: 2}, false, fastTierQueue)
	// The first cohort takes the remainder of the uneven split, and the claims leave one at a time.
	harness.expectClaim(3).respond <- fakeClaimResponse{tasks: harness.tasks(3, dispatchTaskType)}
	first := harness.expectExecutions(3)
	harness.expectClaim(2).respond <- fakeClaimResponse{tasks: harness.tasks(2, dispatchTaskType)}
	second := harness.expectExecutions(2)
	expectCohorts(t, first, 0, 0, 0)
	expectCohorts(t, second, 1, 1)
	harness.expectNoClaim(50 * time.Millisecond)
	if err := harness.stop(nil, append(first, second...)); err != nil {
		t.Fatal(err)
	}
}

func TestDispatchClaimsForTheWholeWorkerOnAFullTierQueue(t *testing.T) {
	harness := startDispatch(t, WorkerOptions{Concurrency: 8, Cohorts: 2}, false)
	harness.expectClaim(8).respond <- fakeClaimResponse{tasks: harness.tasks(8, dispatchTaskType)}
	executions := harness.expectExecutions(8)
	// Tasks a claim for the whole worker returns spread over both cohorts.
	members := map[int]int{}
	for _, execution := range executions {
		members[execution.task.slot.cohort]++
	}
	if members[0] != 4 || members[1] != 4 {
		t.Fatalf("cohort members: got %v, want four in each", members)
	}
	if err := harness.stop(nil, executions); err != nil {
		t.Fatal(err)
	}
}

func TestFusedCompletionClaimsOnlyItsCohortsFreeSlots(t *testing.T) {
	harness := startDispatchOn(t, WorkerOptions{Concurrency: 8, Cohorts: 2}, false, fastTierQueue)
	harness.expectClaim(4).respond <- fakeClaimResponse{tasks: harness.tasks(4, dispatchTaskType)}
	first := harness.expectExecutions(4)
	harness.expectClaim(4).respond <- fakeClaimResponse{tasks: harness.tasks(4, dispatchTaskType)}
	second := harness.expectExecutions(4)

	// A finished execution in cohort 1 frees one slot, and a plain claim for cohort 1 takes it.
	second[0].finish <- nil
	plain := harness.expectClaim(1)

	// That claim holds back a completion in cohort 1: one slot is below the refill batch of two.
	if reservation := harness.reserve(second[1]); reservation != nil {
		t.Fatalf("a completion in cohort 1 reserved %d slots beside its cohort's claim", reservation.limit)
	}
	// A completion in cohort 0 claims only its own slot, although no claim is in flight for it.
	reservation := harness.reserve(first[0])
	if reservation == nil || reservation.limit != 1 || reservation.cohort != 0 {
		t.Fatalf("cohort 0 reservation: got %+v, want one slot in cohort 0", reservation)
	}
	replacement := harness.tasks(1, dispatchTaskType)
	reservation.settle(replacement, true)
	next := harness.expectExecutions(1)
	expectCohorts(t, next, 0)
	// The replacement took the completing task's slot, so its execution ending frees nothing.
	first[0].finish <- nil
	harness.expectNoClaim(50 * time.Millisecond)

	executions := append(append(first[1:], second[1:]...), next...)
	if err := harness.stop([]fakeClaimCall{plain}, executions); err != nil {
		t.Fatal(err)
	}
}

func TestFusedCompletionThatClaimsNothingReturnsItsSlot(t *testing.T) {
	harness := startDispatchOn(t, WorkerOptions{Concurrency: 2}, false, fastTierQueue)
	harness.expectClaim(2).respond <- fakeClaimResponse{tasks: harness.tasks(2, dispatchTaskType)}
	executions := harness.expectExecutions(2)
	reservation := harness.reserve(executions[0])
	if reservation == nil || reservation.limit != 1 {
		t.Fatalf("reservation: got %+v, want one slot", reservation)
	}
	// A completion that fell back to complete_v1 says nothing about the backlog.
	reservation.settle(nil, false)
	executions[0].finish <- nil
	call := harness.expectClaim(1)
	if err := harness.stop([]fakeClaimCall{call}, executions[1:]); err != nil {
		t.Fatal(err)
	}
}

func TestFusedCompletionFallsBackToWholeWorkerClaimsWhenTheQueueLeavesTheFastTier(t *testing.T) {
	harness := startDispatchOn(t, WorkerOptions{Concurrency: 8, Cohorts: 2}, false, fastTierQueue)
	harness.expectClaim(4).respond <- fakeClaimResponse{tasks: harness.tasks(4, dispatchTaskType)}
	first := harness.expectExecutions(4)
	harness.expectClaim(4).respond <- fakeClaimResponse{tasks: harness.tasks(4, dispatchTaskType)}
	second := harness.expectExecutions(4)

	// PostgreSQL refused the batched completion, so writeCompletion marks the queue full tier and
	// settles the task through complete_v1.
	reservation := harness.reserve(first[0])
	harness.worker.markFullTier(harness.worker.queues[0])
	reservation.settle(nil, false)
	first[0].finish <- nil
	first[1].finish <- nil
	// Without cohorts, both free slots go to one claim for the whole worker.
	call := harness.expectClaim(1)
	if err := harness.stop([]fakeClaimCall{call}, append(first[2:], second...)); err != nil {
		t.Fatal(err)
	}
}

func TestFusedCompletionIsDeclinedWhilePaused(t *testing.T) {
	harness := startDispatchOn(t, WorkerOptions{Concurrency: 2}, false, fastTierQueue)
	harness.expectClaim(2).respond <- fakeClaimResponse{tasks: harness.tasks(2, dispatchTaskType)}
	executions := harness.expectExecutions(2)
	harness.worker.remotelyPaused.Store(true)
	if reservation := harness.reserve(executions[0]); reservation != nil {
		t.Fatalf("a paused worker reserved %d slots for a completion", reservation.limit)
	}
	if err := harness.stop(nil, executions); err != nil {
		t.Fatal(err)
	}
}

func TestDispatchWaitsForAFusedCompletionAtStop(t *testing.T) {
	harness := startDispatchOn(t, WorkerOptions{Concurrency: 2}, false, fastTierQueue)
	harness.expectClaim(2).respond <- fakeClaimResponse{tasks: harness.tasks(2, dispatchTaskType)}
	executions := harness.expectExecutions(2)
	reservation := harness.reserve(executions[0])
	if reservation == nil {
		t.Fatal("no reservation for the completion")
	}
	harness.cancel()
	select {
	case <-harness.outcome:
		t.Fatal("dispatch returned before the fused completion settled")
	case <-time.After(50 * time.Millisecond):
	}
	// The loop grants no reservation once it stops.
	if late := harness.reserve(executions[1]); late != nil {
		t.Fatalf("a stopping loop reserved %d slots", late.limit)
	}
	// A task the fused claim leased runs although the loop is stopping.
	reservation.settle(harness.tasks(1, dispatchTaskType), true)
	replacement := harness.expectExecutions(1)
	if err := harness.stop(nil, append(executions, replacement...)); err != nil {
		t.Fatal(err)
	}
}

// deadlockingExecutor loses the first deadlocks deadlock checks, then accepts every completion.
type deadlockingExecutor struct {
	deadlocks int
	sent      [][]string
}

func (executor *deadlockingExecutor) Query(_ context.Context, _ string, arguments ...any) ([]Row, error) {
	ids := arguments[1].([]string)
	executor.sent = append(executor.sent, ids)
	if len(executor.sent) <= executor.deadlocks {
		return nil, &pgconn.PgError{Code: deadlockDetectedSQLState, Message: "deadlock detected"}
	}
	accepted := make([]any, len(ids))
	for index, id := range ids {
		accepted[index] = id
	}
	return []Row{{rowAcceptedField: accepted}}, nil
}

func completionChunk(executor Executor, ids ...string) []*completionEntry {
	chunk := make([]*completionEntry, len(ids))
	for index, id := range ids {
		chunk[index] = &completionEntry{
			ctx: context.Background(), executor: executor, task: ClaimedTask{ID: id, FenceToken: 1},
			encoded: json.RawMessage(`null`), answer: make(chan completionAnswer, 1),
		}
	}
	return chunk
}

// A heartbeat names its leases in task ID order. A batched completion names its tasks in the same
// order, and sends the chunk again when PostgreSQL rolled it back to break a deadlock.
func TestBatchedCompletionNamesTasksInIDOrderAndRetriesADeadlock(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{})
	executor := &deadlockingExecutor{deadlocks: completionDeadlockAttempts - 1}
	chunk := completionChunk(executor, "c", "a", "b")
	worker.completeChunk("defaults", chunk)
	if len(executor.sent) != completionDeadlockAttempts {
		t.Fatalf("sent the chunk %d times", len(executor.sent))
	}
	if fmt.Sprint(executor.sent[0]) != "[a b c]" {
		t.Fatalf("named the tasks as %v", executor.sent[0])
	}
	for _, entry := range chunk {
		if answer := <-entry.answer; answer.err != nil || !answer.accepted {
			t.Fatalf("task %s answered %#v", entry.task.ID, answer)
		}
	}

	executor = &deadlockingExecutor{deadlocks: completionDeadlockAttempts}
	chunk = completionChunk(executor, "a")
	worker.completeChunk("defaults", chunk)
	if answer := <-chunk[0].answer; !hasSQLState(answer.err, deadlockDetectedSQLState) {
		t.Fatalf("a chunk that kept deadlocking answered %#v", answer)
	}
	if len(executor.sent) != completionDeadlockAttempts {
		t.Fatalf("sent the chunk %d times", len(executor.sent))
	}
}
