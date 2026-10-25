package workhorse

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
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
	// notificationDelay is the delay a notified claim waits when it waits. It defaults to none.
	notificationDelay atomic.Int64
	// delayEntered runs when a notified claim enters its delay, before the delay starts. Nil runs
	// nothing.
	delayEntered atomic.Pointer[func()]
	// settled receives whether each claim that the loop settles was skipped.
	settled chan bool
	// withoutHeartbeat closes the claim gate, as a pool without its heartbeat connection does.
	withoutHeartbeat atomic.Bool
	// notListening reports that the subscription is not live. The loop then polls at the
	// polling-only base.
	notListening atomic.Bool
	// gate, when set, answers each read of the claim gate in place of withoutHeartbeat.
	gate      atomic.Pointer[func() bool]
	heartbeat chan struct{}
	cancel    context.CancelFunc
	outcome   chan dispatchOutcome
	nextTask  int
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
	return startDispatchWith(t, worker, tier)
}

// startDispatchWith starts one more dispatch run on worker, as a restarted Run does.
func startDispatchWith(t *testing.T, worker *Worker, tier dispatchTier) *dispatchHarness {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	harness := &dispatchHarness{
		t:            t,
		worker:       worker,
		claims:       make(chan fakeClaimCall),
		executions:   make(chan fakeExecution, 100),
		results:      make(chan executionResult, 2*worker.concurrency),
		notification: make(chan struct{}, 1),
		registry:     make(chan struct{}, 1),
		heartbeat:    make(chan struct{}, 1),
		settled:      make(chan bool, 100),
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
			listening:        func() bool { return !harness.notListening.Load() },
			claimable: func() bool {
				if gate := harness.gate.Load(); gate != nil {
					return (*gate)()
				}
				return !harness.withoutHeartbeat.Load()
			},
			heartbeatWake: harness.heartbeat,
			claimSettled: func(skipped bool) {
				// A test that does not read settlements must not block the loop.
				select {
				case harness.settled <- skipped:
				default:
				}
			},
			notificationDelay: func() time.Duration {
				if entered := harness.delayEntered.Load(); entered != nil {
					(*entered)()
				}
				return time.Duration(harness.notificationDelay.Load())
			},
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
			awaitSignal(harness.t, harness.results, "the result of each execution after the stop")
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

// SM-1648: when the subscription is lost, the empty claims of the live period do not count. So the
// backoff starts again at the polling-only base, and not at its ceiling.
func TestDispatchRestartsTheBackoffWhenTheSubscriptionIsLost(t *testing.T) {
	harness := startDispatch(t, WorkerOptions{Concurrency: 1}, false)
	// With a live subscription, each empty claim adds to the count. A notification ends each wait.
	for range 6 {
		harness.expectClaim(1).respond <- fakeClaimResponse{}
		// The loop chooses the wait of the empty claim when it settles the claim.
		awaitSignal(t, harness.settled, "the empty claim to settle")
		harness.notification <- struct{}{}
	}

	// The subscription is lost before the next empty claim chooses its wait.
	harness.notListening.Store(true)
	harness.expectClaim(1).respond <- fakeClaimResponse{}
	emptyAt := time.Now()
	call := harness.expectClaim(1)
	if waited := time.Since(emptyAt); waited > 2*defaultWorkerPollInterval {
		t.Fatalf("claimed again after %s, want about the %s polling-only base", waited, defaultWorkerPollInterval)
	}
	// The next empty claim continues the backoff from the restart.
	call.respond <- fakeClaimResponse{}
	emptyAt = time.Now()
	call = harness.expectClaim(1)
	if waited := time.Since(emptyAt); waited < defaultWorkerPollInterval*2*9/10 || waited > 4*defaultWorkerPollInterval {
		t.Fatalf("claimed again after %s, want about twice the %s polling-only base", waited, defaultWorkerPollInterval)
	}
	if err := harness.stop([]fakeClaimCall{call}, nil); err != nil {
		t.Fatal(err)
	}
}

// testNotificationDelay is longer than any wait a test makes for a claim it expects at once.
const testNotificationDelay = 300 * time.Millisecond

// SM-933: a dependency release notifies the queue on every completion. A busy worker that paid the
// notification delay on each of those claims spent most of its time asleep.
func TestDispatchDelaysANotifiedClaimOnlyAfterAClaimThatFoundNothing(t *testing.T) {
	harness := startDispatch(t, WorkerOptions{Concurrency: 2, PollInterval: time.Minute}, false)
	harness.notificationDelay.Store(int64(testNotificationDelay))
	harness.expectClaim(2).respond <- fakeClaimResponse{tasks: harness.tasks(2, dispatchTaskType)}
	executions := harness.expectExecutions(2)

	// The last claim found work, so the claim a notification precedes starts at once.
	harness.notification <- struct{}{}
	harness.expectNoClaim(50 * time.Millisecond)
	freedAt := time.Now()
	executions[0].finish <- nil
	call := harness.expectClaim(1)
	if waited := time.Since(freedAt); waited >= testNotificationDelay {
		t.Fatalf("a busy worker claimed after %s, want no notification delay", waited)
	}

	// After an empty claim the worker is idle, so a notification ends its wait with the delay.
	call.respond <- fakeClaimResponse{}
	harness.expectNoClaim(50 * time.Millisecond)
	notifiedAt := time.Now()
	harness.notification <- struct{}{}
	call = harness.expectClaim(1)
	if waited := time.Since(notifiedAt); waited < testNotificationDelay {
		t.Fatalf("an idle worker claimed after %s, want the %s notification delay", waited, testNotificationDelay)
	}
	if err := harness.stop([]fakeClaimCall{call}, executions[1:]); err != nil {
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
			awaitSignal(t, harness.results, "the result of each execution after the stop")
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
	return execution.task.slot.claimer.reserve(execution.task)
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

// claimLimitRecorder answers a batched completion that claims nothing, and records the claim limit
// the statement sent.
type claimLimitRecorder struct {
	limits chan int
}

func (recorder claimLimitRecorder) Query(_ context.Context, _ string, arguments ...any) ([]Row, error) {
	recorder.limits <- arguments[5].(int)
	return []Row{{rowAcceptedField: []any{}}}, nil
}

// SM-1579: Run returned ErrShutdownIncomplete with a fast-tier handler still running, and the caller
// started the same Worker again. The old handler's completion belongs to the run that ended. It
// must not reserve slots of the new run or claim tasks for them.
func TestAFastCompletionOfAnEndedRunClaimsNothingForTheNextRun(t *testing.T) {
	ended := startDispatchOn(t, WorkerOptions{Concurrency: 2}, false, fastTierQueue)
	ended.expectClaim(2).respond <- fakeClaimResponse{tasks: ended.tasks(2, dispatchTaskType)}
	abandoned := ended.expectExecutions(2)
	ended.cancel()
	outcome := awaitSignal(t, ended.outcome, "the ended dispatch loop to return")
	if outcome.active != 2 {
		t.Fatalf("the ended run left %d executions, want 2", outcome.active)
	}

	next := startDispatchWith(t, ended.worker, fastTierQueue)
	// The second handler returns. Its slot is the one free slot of the next run (SM-1582).
	abandoned[1].finish <- nil
	awaitSignal(t, ended.results, "the result of the second abandoned execution")
	pending := next.expectClaim(1)
	recorder := claimLimitRecorder{limits: make(chan int, 1)}
	completed := make(chan error, 1)
	go func() {
		_, err := ended.worker.writeFastCompletion(
			context.Background(), recorder, abandoned[0].task, json.RawMessage(`null`),
		)
		completed <- err
	}()
	if limit := awaitSignal(t, recorder.limits, "the claim limit of the ended run's completion"); limit != 0 {
		t.Fatalf("the ended run's completion claimed %d tasks for the next run", limit)
	}
	if err := awaitSignal(t, completed, "the ended run's completion to return"); err != nil {
		t.Fatal(err)
	}
	if err := next.stop([]fakeClaimCall{pending}, nil); err != nil {
		t.Fatal(err)
	}
	abandoned[0].finish <- nil
	awaitSignal(t, ended.results, "the result of the first abandoned execution")
}

// endRunWithAbandonedExecutions stands in for a Run that returned ErrShutdownIncomplete: its
// dispatch loop returned while count executions still run. The cleanup finishes the executions that
// the test did not finish.
func endRunWithAbandonedExecutions(t *testing.T, concurrency int) (*dispatchHarness, []func()) {
	t.Helper()
	ended := startDispatch(t, WorkerOptions{Concurrency: concurrency, PollInterval: time.Hour}, false)
	ended.expectClaim(concurrency).respond <- fakeClaimResponse{tasks: ended.tasks(concurrency, dispatchTaskType)}
	abandoned := ended.expectExecutions(concurrency)
	ended.cancel()
	if outcome := awaitSignal(t, ended.outcome, "the ended dispatch loop to return"); outcome.active != concurrency {
		t.Fatalf("the ended run left %d executions, want %d", outcome.active, concurrency)
	}
	finish := make([]func(), len(abandoned))
	for index, execution := range abandoned {
		var once sync.Once
		// The execution sends its result after it frees its slot.
		finish[index] = func() {
			once.Do(func() {
				execution.finish <- nil
				awaitSignal(t, ended.results, "the result of an abandoned execution")
			})
		}
		t.Cleanup(finish[index])
	}
	return ended, finish
}

// SM-1582: Run returned ErrShutdownIncomplete with 2 handlers still running, and the caller started
// the same Worker again. Those handlers still hold both slots of Concurrency 2. When one of them
// returns, the next run claims 1 task, and its stop ends although the other handler still runs.
func TestTheNextRunClaimsOnlyTheSlotsThatTheHandlersOfAnEndedRunFree(t *testing.T) {
	ended, finishAbandoned := endRunWithAbandonedExecutions(t, 2)
	next := startDispatchWith(t, ended.worker, fullTierQueue)
	finishAbandoned[0]()
	// A queue with a backlog returns as many tasks as the claim asks for.
	var call fakeClaimCall
	select {
	case call = <-next.claims:
	case <-time.After(2 * time.Second):
		t.Fatal("the next run did not claim the slot that the ended run's handler freed")
	}
	call.respond <- fakeClaimResponse{tasks: next.tasks(call.limit, dispatchTaskType)}
	started := next.expectExecutions(1)
	next.cancel()
	select {
	case outcome := <-next.outcome:
		if outcome.active != 1 {
			t.Fatalf("the next run left %d executions, want 1", outcome.active)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the next run's dispatch loop did not return after its stop")
	}
	if call.limit != 1 {
		t.Fatalf("the next run claimed %d tasks while the ended run's handlers held 1 of 2 slots", call.limit)
	}
	started[0].finish <- nil
	awaitSignal(t, next.results, "the result of the next run's execution")
}

// SM-1582: when a handler of an ended run returns, the next run claims its slot at once. The poll
// interval is one hour, so only the wake of the freed slot can start that claim.
func TestTheNextRunClaimsASlotThatAnEndedRunFreesWithoutAPoll(t *testing.T) {
	ended, finishAbandoned := endRunWithAbandonedExecutions(t, 2)
	next := startDispatchWith(t, ended.worker, fullTierQueue)
	// The test holds one pass of the loop at its claim gate, before the pass counts its free slots.
	// It frees a slot there, and it closes the gate for that pass, so the pass starts no claim.
	checked := make(chan struct{})
	answer := make(chan bool)
	var held atomic.Bool
	gate := func() bool {
		if !held.CompareAndSwap(false, true) {
			return true
		}
		checked <- struct{}{}
		return <-answer
	}
	next.gate.Store(&gate)
	next.registry <- struct{}{}
	select {
	case <-checked:
	case <-time.After(2 * time.Second):
		t.Fatal("no pass of the next run's dispatch loop read the claim gate")
	}
	// If the held pass is the first pass, the registry wake is still in its buffer. Remove it, so it
	// cannot start the next pass.
	select {
	case <-next.registry:
	default:
	}
	finishAbandoned[0]()
	answer <- false
	call := next.expectClaim(1)
	if err := next.stop([]fakeClaimCall{call}, nil); err != nil {
		t.Fatal(err)
	}
}

// failingExecutor fails the test on any statement.
type failingExecutor struct {
	t *testing.T
}

func (executor failingExecutor) Query(context.Context, string, ...any) ([]Row, error) {
	executor.t.Error("RunOnce sent a statement while the ended run's handlers held every slot")
	return nil, errors.New("unexpected statement")
}

// SM-1582: RunOnce is a run of the same Worker. While the handlers of an ended run hold every slot,
// it claims nothing.
func TestRunOnceClaimsNothingWhileTheHandlersOfAnEndedRunHoldEverySlot(t *testing.T) {
	ended, _ := endRunWithAbandonedExecutions(t, 1)
	processed, err := ended.worker.runOnce(context.Background(), failingExecutor{t: t})
	if processed || err != nil {
		t.Fatalf("runOnce = %v, %v; want false, nil", processed, err)
	}
}

// heldBatchExecutor holds every batched completion that names held until release closes, and
// reports the tasks of each statement.
type heldBatchExecutor struct {
	held    string
	release chan struct{}
	sent    chan []string
}

func (executor heldBatchExecutor) Query(_ context.Context, _ string, arguments ...any) ([]Row, error) {
	ids := arguments[1].([]string)
	executor.sent <- ids
	if slices.Contains(ids, executor.held) {
		<-executor.release
	}
	return []Row{{rowAcceptedField: []any{}}}, nil
}

// SM-1579: a completion of an ended run goes in its own statement. If it joined a batch of the next
// run, its cancelled context could fail that batch, or it could wait behind it.
func TestAFastCompletionOfAnEndedRunDoesNotJoinTheNextRunsBatch(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{})
	stoppedClaimer := func() *completionClaimer {
		claimer := &completionClaimer{done: make(chan struct{})}
		close(claimer.done)
		return claimer
	}
	ended, next := stoppedClaimer(), stoppedClaimer()
	executor := heldBatchExecutor{held: "b-next", release: make(chan struct{}), sent: make(chan []string, 2)}
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(executor.release) }) }
	t.Cleanup(release)
	complete := func(id string, claimer *completionClaimer) chan error {
		completed := make(chan error, 1)
		task := ClaimedTask{ID: id, Queue: "defaults", slot: &dispatchSlot{claimer: claimer}}
		go func() {
			_, err := worker.writeFastCompletion(context.Background(), executor, task, json.RawMessage(`null`))
			completed <- err
		}()
		return completed
	}

	nextCompleted := complete("b-next", next)
	if ids := awaitSignal(t, executor.sent, "the next run's completion statement"); fmt.Sprint(ids) != "[b-next]" {
		t.Fatalf("the next run's statement named %v", ids)
	}
	endedCompleted := complete("a-ended", ended)
	select {
	case ids := <-executor.sent:
		if fmt.Sprint(ids) != "[a-ended]" {
			t.Fatalf("the ended run's statement named %v", ids)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the ended run's completion waited for the next run's batch")
	}
	release()
	for _, completed := range []chan error{nextCompleted, endedCompleted} {
		if err := awaitSignal(t, completed, "each completion to return after the release"); err != nil {
			t.Fatal(err)
		}
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
	executor := &deadlockingExecutor{deadlocks: fencedWriteDeadlockAttempts - 1}
	chunk := completionChunk(executor, "c", "a", "b")
	worker.completeChunk("defaults", chunk)
	if len(executor.sent) != fencedWriteDeadlockAttempts {
		t.Fatalf("sent the chunk %d times", len(executor.sent))
	}
	if fmt.Sprint(executor.sent[0]) != "[a b c]" {
		t.Fatalf("named the tasks as %v", executor.sent[0])
	}
	for _, entry := range chunk {
		if answer := awaitSignal(t, entry.answer, "the answer of each task in the chunk"); answer.err != nil || !answer.accepted {
			t.Fatalf("task %s answered %#v", entry.task.ID, answer)
		}
	}

	executor = &deadlockingExecutor{deadlocks: fencedWriteDeadlockAttempts}
	chunk = completionChunk(executor, "a")
	worker.completeChunk("defaults", chunk)
	if answer := awaitSignal(t, chunk[0].answer, "the answer of the deadlocked chunk"); !hasSQLState(answer.err, deadlockDetectedSQLState) {
		t.Fatalf("a chunk that kept deadlocking answered %#v", answer)
	}
	if len(executor.sent) != fencedWriteDeadlockAttempts {
		t.Fatalf("sent the chunk %d times", len(executor.sent))
	}
}

// SM-1026: a lifecycle error stops the loop while the caller's context is still live. Run's grace
// period ends a stalled claim, so the loop must start it before it waits for that claim.
func TestDispatchStartsTheShutdownBeforeWaitingForAStalledClaim(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{Concurrency: 2})
	worker.Handle(dispatchTaskType, func(context.Context, any, *HandlerContext) (any, error) {
		return nil, nil
	})
	drain, expireDrain := context.WithCancel(context.Background())
	t.Cleanup(expireDrain)
	claimStarted := make(chan struct{})
	maintenanceErrors := make(chan error, 1)
	outcome := make(chan dispatchOutcome, 1)
	go func() {
		active, err := worker.dispatch(context.Background(), dispatchEnvironment{
			claim: func(int, int) ([]ClaimedTask, error) {
				worker.markFullTier(worker.queues[0])
				close(claimStarted)
				<-drain.Done()
				return nil, drain.Err()
			},
			execute:           func(ClaimedTask) error { return nil },
			executionResults:  make(chan executionResult, 4),
			notificationWake:  make(chan struct{}),
			registryWake:      make(chan struct{}),
			maintenanceErrors: maintenanceErrors,
			listening:         func() bool { return true },
			stopped:           expireDrain,
		})
		outcome <- dispatchOutcome{active: active, err: err}
	}()
	awaitSignal(t, claimStarted, "the stalled claim to start")
	maintenanceErr := fmt.Errorf("maintenance failed")
	maintenanceErrors <- maintenanceErr
	select {
	case result := <-outcome:
		if result.err != maintenanceErr {
			t.Fatalf("dispatch returned %v, want the maintenance error", result.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("dispatch waited for a claim that only the shutdown ends")
	}
}

// The deadline cancels the executions as soon as the grace period ends, so a cancelled execution's
// result can already be buffered when the drain observes the deadline. Both are ready at once, and
// select picks either; repeating the drain makes a result that depends on the pick fail reliably.
func TestDrainTreatsADeadlineCancellationAsPartOfTheUnwind(t *testing.T) {
	worker := &Worker{}
	operational := errors.New("operational failure")
	for attempt := range 200 {
		drainContext, expire := context.WithCancel(context.Background())
		expire()
		results := make(chan executionResult, 1)
		results <- executionResult{err: fmt.Errorf("write failure: %w", context.Canceled)}
		abandoned, err := worker.drainExecutions(drainContext, results, 1, nil, func() {})
		if abandoned != 0 || err != nil {
			t.Fatalf("attempt %d: drain returned %d abandoned and %v, want 0 and nil",
				attempt, abandoned, err)
		}

		results <- executionResult{err: fmt.Errorf("write failure: %w", context.Canceled)}
		_, err = worker.drainExecutions(drainContext, results, 1, operational, func() {})
		if !errors.Is(err, operational) {
			t.Fatalf("attempt %d: drain returned %v, want the error captured before the deadline",
				attempt, err)
		}
	}

	// Before the deadline, a cancellation is an ordinary execution error.
	results := make(chan executionResult, 1)
	results <- executionResult{err: context.Canceled}
	_, err := worker.drainExecutions(context.Background(), results, 1, nil, func() {})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("drain before the deadline returned %v, want context.Canceled", err)
	}
}

// SM-1676: a fused claim asks only the completing task's queue. While one fast-tier queue kept a
// backlog, its completions refilled every slot, no plain claim started, and the other queues got
// no claim until that backlog was empty.
func TestDispatchGivesAnotherQueueAClaimWhileAFastQueueKeepsABacklog(t *testing.T) {
	const backlog = 200
	worker, err := NewWorker(unconnectedPool(t), WorkerOptions{
		Queues:           []string{"a", "b"},
		WorkerID:         "fairness-worker",
		Concurrency:      1,
		PollInterval:     100 * time.Millisecond,
		SharedHeartbeats: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle(dispatchTaskType, func(context.Context, any, *HandlerContext) (any, error) {
		return nil, nil
	})
	var mu sync.Mutex
	waiting := map[string][]ClaimedTask{"b": {{ID: "b-0", Type: dispatchTaskType, Queue: "b"}}}
	for index := range backlog {
		waiting["a"] = append(waiting["a"], ClaimedTask{ID: fmt.Sprintf("a-%d", index), Type: dispatchTaskType, Queue: "a"})
	}
	take := func(queue string, limit int) []ClaimedTask {
		mu.Lock()
		defer mu.Unlock()
		count := min(limit, len(waiting[queue]))
		taken := slices.Clone(waiting[queue][:count])
		waiting[queue] = waiting[queue][count:]
		return taken
	}
	type fusedClaim struct {
		id    string
		limit int
	}
	// The fused claim limit of each completion of queue a, in completion order.
	var fused []fusedClaim
	var ran []string
	coldRan := make(chan struct{})
	results := make(chan executionResult, 2)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	outcome := make(chan int, 1)
	go func() {
		active, _ := worker.dispatch(ctx, dispatchEnvironment{
			// A plain claim asks the queues in rotation, as claimNextMany does.
			claim: func(limit int, fastLimit int) ([]ClaimedTask, error) {
				var tasks []ClaimedTask
				for range worker.queues {
					queue := worker.nextClaimQueue()
					worker.markFastTier(queue)
					tasks = append(tasks, take(queue, fastLimit-len(tasks))...)
					if len(tasks) == limit {
						break
					}
				}
				return tasks, nil
			},
			// A completion reserves its fused claim, as writeFastCompletion does.
			execute: func(task ClaimedTask) error {
				mu.Lock()
				ran = append(ran, task.ID)
				mu.Unlock()
				if task.ID == "b-0" {
					close(coldRan)
				}
				time.Sleep(2 * time.Millisecond)
				reservation := task.slot.claimer.reserve(task)
				limit := 0
				if reservation != nil {
					limit = reservation.limit
				}
				if task.Queue == "a" {
					mu.Lock()
					fused = append(fused, fusedClaim{id: task.ID, limit: limit})
					mu.Unlock()
				}
				reservation.settle(take(task.Queue, limit), limit > 0)
				return nil
			},
			executionResults: results,
			listening:        func() bool { return true },
		})
		outcome <- active
	}()
	select {
	case <-coldRan:
	case <-time.After(5 * time.Second):
		t.Fatal("the task of queue b did not run")
	}
	cancel()
	select {
	case active := <-outcome:
		for range active {
			<-results
		}
	case <-time.After(2 * time.Second):
		t.Fatal("dispatch did not stop")
	}

	mu.Lock()
	defer mu.Unlock()
	// Once queue b has waited a poll interval, one completion of queue a claims nothing. Its slot
	// goes to a plain claim, which asks b next. Every other completion of a still refills its slot.
	coldAt := slices.Index(ran, "b-0")
	if coldAt >= backlog/2 {
		t.Fatalf("the task of queue b ran after %d tasks of queue a, want fewer than %d", coldAt, backlog/2)
	}
	skip := slices.IndexFunc(fused, func(claim fusedClaim) bool { return claim.limit == 0 })
	// Under load the first completion can already find queue b waiting, so the skip can be first.
	if skip < 0 {
		t.Fatal("no completion of queue a skipped its refill")
	}
	for index, claim := range fused[:skip] {
		if claim.limit != 1 {
			t.Fatalf("completion %d claimed %d slots before the skip, want 1", index, claim.limit)
		}
	}
	if fused[skip].id != ran[coldAt-1] {
		t.Fatalf("completion %s skipped its refill, want %s, the task before b-0", fused[skip].id, ran[coldAt-1])
	}
}

// SM-1676: while a plain claim for cohort 1 was in flight, a cohort 0 completion skipped its refill
// and gave its slot back. The next cohort 0 completion then claimed that slot too, so no plain claim
// started and queue b waited again.
func TestDispatchKeepsTheSlotOfAFairnessSkipFreeForAPlainClaim(t *testing.T) {
	worker, err := NewWorker(unconnectedPool(t), WorkerOptions{
		Queues:           []string{"a", "b"},
		WorkerID:         "fairness-worker",
		Concurrency:      4,
		Cohorts:          2,
		PollInterval:     20 * time.Millisecond,
		SharedHeartbeats: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle(dispatchTaskType, func(context.Context, any, *HandlerContext) (any, error) {
		return nil, nil
	})
	// Every queue is fast tier, so plain claims leave one at a time, each for one cohort.
	worker.markFastTier("b")
	harness := startDispatchWith(t, worker, fastTierQueue)
	queueTasks := func(count int) []ClaimedTask {
		tasks := harness.tasks(count, dispatchTaskType)
		for index := range tasks {
			tasks[index].Queue = "a"
		}
		return tasks
	}
	harness.expectClaim(2).respond <- fakeClaimResponse{tasks: queueTasks(2)}
	first := harness.expectExecutions(2)
	harness.expectClaim(2).respond <- fakeClaimResponse{tasks: queueTasks(2)}
	second := harness.expectExecutions(2)
	expectCohorts(t, append(first, second...), 0, 0, 1, 1)

	// A finished execution in cohort 1 starts a plain claim, which the test holds in flight.
	second[0].finish <- nil
	plain := harness.expectClaim(1)
	// Queue b has waited a fairness interval.
	worker.queueCursorMu.Lock()
	worker.queueAskedAt["b"] = time.Now().Add(-time.Second)
	worker.queueCursorMu.Unlock()

	// A cohort 0 completion skips its refill and gives its slot back. The claim in flight holds
	// back a new plain claim.
	if reservation := harness.reserve(first[0]); reservation != nil {
		t.Fatalf("the first cohort 0 completion reserved %d slots, want a fairness skip", reservation.limit)
	}
	activeBefore := worker.activeSlots.Load()
	first[0].finish <- nil
	for worker.activeSlots.Load() == activeBefore {
		time.Sleep(time.Millisecond)
	}
	harness.expectNoClaim(50 * time.Millisecond)

	// The next cohort 0 completion refills only its own slot, not the slot of the skip.
	reservation := harness.reserve(first[1])
	if reservation == nil || reservation.limit != 1 {
		t.Fatalf("the second cohort 0 reservation: got %+v, want one slot", reservation)
	}
	reservation.settle(nil, true)
	if err := harness.stop([]fakeClaimCall{plain}, append(first[1:], second[1:]...)); err != nil {
		t.Fatal(err)
	}
}
