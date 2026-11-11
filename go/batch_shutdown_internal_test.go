package workhorse

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

// batchSettlementExecutor counts the settlement statements of one attempt and accepts each.
type batchSettlementExecutor struct{ failed, released, completed int }

func (executor *batchSettlementExecutor) Query(
	_ context.Context,
	statement string,
	_ ...any,
) ([]Row, error) {
	switch statement {
	case protocolStatementRegistry[failStatementName]:
		executor.failed++
		return []Row{{rowStateField: workerFailureFailed}}, nil
	case protocolStatementRegistry[releaseOwnedStatementName]:
		executor.released++
		return []Row{{rowStatusField: workerReleaseReleased}}, nil
	case protocolStatementRegistry[completeStatementName]:
		executor.completed++
		return []Row{{rowAcceptedField: true}}, nil
	}
	return nil, errors.New("unexpected statement")
}

// awaitReturnRecords waits until the dispatch recorded the return of the batch handler for each
// item, so a cancellation that the test sends next comes after that record.
func awaitReturnRecords(t *testing.T, items <-chan []BatchHandlerItem) {
	t.Helper()
	var recorded []BatchHandlerItem
	select {
	case recorded = <-items:
	case <-time.After(5 * time.Second):
		t.Fatal("the batch handler did not return")
	}
	deadline := time.Now().Add(5 * time.Second)
	for _, item := range recorded {
		for item.Context.handler.returned.Load() == nil {
			if time.Now().After(deadline) {
				t.Fatal("the dispatch did not record the return of the batch handler")
			}
			time.Sleep(time.Millisecond)
		}
	}
}

// ADR 0117: a batch member reads its cancellation cause as soon as the batch handler returns, before
// it waits for the coordinator lock. If the shutdown cancellation comes while another member holds
// that lock, the failure of the handler still goes to fail_v1, with its own error.
func TestBatchMemberKeepsAFailureWhenTheCancellationComesDuringALockWait(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{})
	entered := make(chan struct{})
	returnCallback := make(chan struct{})
	returned := make(chan []BatchHandlerItem, 1)
	coordinator := &batchCoordinator{
		worker: worker, taskType: "batch", options: BatchHandlerOptions{MaxSize: 1},
		pending: make(map[string][]*batchMember),
		handler: func(items []BatchHandlerItem) []BatchHandlerOutcome {
			close(entered)
			<-returnCallback
			defer func() { returned <- items }()
			return []BatchHandlerOutcome{BatchFailed{Error: errors.New("callback failure")}}
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	executor := &batchSettlementExecutor{}
	var handled error
	done := make(chan error, 1)
	go func() {
		done <- worker.execute(ctx, executor, claimedResultTask(t), func(
			ctx context.Context,
			payload any,
			handler *HandlerContext,
		) (any, error) {
			value, err := coordinator.handle(ctx, payload, handler)
			handled = err
			<-ctx.Done()
			return value, err
		})
	}()
	waitFor(t, entered, "the batch handler did not start")
	// Another member holds the coordinator lock while the batch handler returns.
	coordinator.mu.Lock()
	close(returnCallback)
	awaitReturnRecords(t, returned)
	cancel()
	coordinator.mu.Unlock()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the execution did not finish")
	}
	if executor.failed != 1 || executor.released != 0 {
		t.Fatalf("fail_v1 ran %d times and release_owned_v1 %d times, want 1 and 0",
			executor.failed, executor.released)
	}
	if handled == nil || handled.Error() != "callback failure" {
		t.Fatalf("the member settled with %v, want the callback failure", handled)
	}
}

// The same rule for a member that waits while another member runs the batch handler. The record of
// the return does not wait for the coordinator lock, so a cancellation that comes while that lock
// is busy reaches each member after its record, and each member keeps the failure.
func TestWaitingBatchMemberKeepsAFailureWhenTheCancellationComesDuringALockWait(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{})
	returnCallback := make(chan struct{})
	returned := make(chan []BatchHandlerItem, 1)
	entered := make(chan struct{})
	coordinator := &batchCoordinator{
		worker: worker, taskType: "batch", options: BatchHandlerOptions{MaxSize: 2, Linger: time.Minute},
		pending: make(map[string][]*batchMember),
		handler: func(items []BatchHandlerItem) []BatchHandlerOutcome {
			close(entered)
			<-returnCallback
			defer func() { returned <- items }()
			outcomes := make([]BatchHandlerOutcome, len(items))
			for index := range items {
				outcomes[index] = BatchFailed{Error: errors.New("callback failure")}
			}
			return outcomes
		},
	}
	type member struct {
		executor *batchSettlementExecutor
		cancel   context.CancelFunc
		done     chan error
		handled  error
	}
	members := make([]*member, 2)
	for index := range members {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		current := &member{executor: &batchSettlementExecutor{}, cancel: cancel, done: make(chan error, 1)}
		members[index] = current
		go func() {
			current.done <- worker.execute(ctx, current.executor, claimedResultTask(t), func(
				ctx context.Context,
				payload any,
				handler *HandlerContext,
			) (any, error) {
				value, err := coordinator.handle(ctx, payload, handler)
				current.handled = err
				<-ctx.Done()
				return value, err
			})
		}()
	}
	waitFor(t, entered, "the batch handler did not start")
	coordinator.mu.Lock()
	close(returnCallback)
	awaitReturnRecords(t, returned)
	for _, current := range members {
		current.cancel()
	}
	coordinator.mu.Unlock()
	for index, current := range members {
		select {
		case <-current.done:
		case <-time.After(5 * time.Second):
			t.Fatalf("the execution of member %d did not finish", index)
		}
		if current.executor.failed != 1 || current.executor.released != 0 {
			t.Fatalf("member %d: fail_v1 ran %d times and release_owned_v1 %d times, want 1 and 0",
				index, current.executor.failed, current.executor.released)
		}
		if current.handled == nil || current.handled.Error() != "callback failure" {
			t.Fatalf("member %d settled with %v, want the callback failure", index, current.handled)
		}
	}
}

// ADR 0117: a value that the batch handler returned before the cancellation keeps the usual result
// check. If the task cannot store the value, the attempt fails, also when the worker reads it only
// after the stop.
func TestBatchMemberFailsAnUnstorableValueFromBeforeTheCancellation(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{})
	returned := make(chan []BatchHandlerItem, 1)
	coordinator := &batchCoordinator{
		worker: worker, taskType: "batch", options: BatchHandlerOptions{MaxSize: 1},
		pending: make(map[string][]*batchMember),
		handler: func(items []BatchHandlerItem) []BatchHandlerOutcome {
			defer func() { returned <- items }()
			return []BatchHandlerOutcome{BatchSucceeded{Result: "a\x00b"}}
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	executor := &batchSettlementExecutor{}
	done := make(chan error, 1)
	go func() {
		done <- worker.execute(ctx, executor, claimedResultTask(t), func(
			ctx context.Context,
			payload any,
			handler *HandlerContext,
		) (any, error) {
			value, err := coordinator.handle(ctx, payload, handler)
			// The stop comes after the batch handler returned, before the worker settles.
			cancel()
			<-ctx.Done()
			return value, err
		})
	}()
	awaitReturnRecords(t, returned)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the execution did not finish")
	}
	if executor.failed != 1 || executor.released != 0 {
		t.Fatalf("fail_v1 ran %d times and release_owned_v1 %d times, want 1 and 0",
			executor.failed, executor.released)
	}
}

// onceMarshaler encodes as a JSON number on its first call and fails on each later call.
type onceMarshaler struct{ calls *atomic.Int32 }

func (value onceMarshaler) MarshalJSON() ([]byte, error) {
	if value.calls.Add(1) > 1 {
		return nil, errors.New("the value was encoded a second time")
	}
	return []byte("1"), nil
}

// A value that the batch handler returned before the cancellation is checked once. The completion
// writes the checked bytes, so the worker does not encode the value a second time.
func TestBatchMemberCompletesAValueFromBeforeTheCancellationWithOneEncode(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{})
	var calls atomic.Int32
	returned := make(chan []BatchHandlerItem, 1)
	coordinator := &batchCoordinator{
		worker: worker, taskType: "batch", options: BatchHandlerOptions{MaxSize: 1},
		pending: make(map[string][]*batchMember),
		handler: func(items []BatchHandlerItem) []BatchHandlerOutcome {
			defer func() { returned <- items }()
			return []BatchHandlerOutcome{BatchSucceeded{Result: onceMarshaler{calls: &calls}}}
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	executor := &batchSettlementExecutor{}
	done := make(chan error, 1)
	go func() {
		done <- worker.execute(ctx, executor, claimedResultTask(t), func(
			ctx context.Context,
			payload any,
			handler *HandlerContext,
		) (any, error) {
			value, err := coordinator.handle(ctx, payload, handler)
			// The stop comes after the batch handler returned, before the worker settles.
			cancel()
			<-ctx.Done()
			return value, err
		})
	}()
	awaitReturnRecords(t, returned)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the execution did not finish")
	}
	if executor.completed != 1 || executor.released != 0 || executor.failed != 0 {
		t.Fatalf("complete_v1 ran %d, release_owned_v1 %d, and fail_v1 %d times, want 1, 0, and 0",
			executor.completed, executor.released, executor.failed)
	}
	if calls.Load() != 1 {
		t.Fatalf("the worker encoded the value %d times, want 1", calls.Load())
	}
}
