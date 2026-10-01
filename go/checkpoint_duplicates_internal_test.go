package workhorse

import (
	"context"
	"errors"
	"testing"
	"time"
)

// emptyCheckpointExecutor finds no saved checkpoint, so every call runs its operation.
type emptyCheckpointExecutor struct{}

func (emptyCheckpointExecutor) Query(context.Context, string, ...any) ([]Row, error) {
	return nil, nil
}

func newCheckpointHandler(ctx context.Context) *HandlerContext {
	return &HandlerContext{
		Task:     ClaimedTask{ID: "task", Queue: "defaults", FenceToken: 1},
		context:  ctx,
		executor: emptyCheckpointExecutor{},
	}
}

type checkpointResult struct {
	value any
	err   error
}

// startDuplicate calls Checkpoint once the initiator is inside its operation and reports when the
// duplicate has registered as a waiter on the in-flight entry.
func startDuplicate(handler *HandlerContext, name string) <-chan checkpointResult {
	result := make(chan checkpointResult, 1)
	go func() {
		value, err := handler.Checkpoint(name, func() (any, error) {
			return "duplicate ran its own operation", nil
		})
		result <- checkpointResult{value, err}
	}()
	return result
}

func awaitDuplicate(t *testing.T, result <-chan checkpointResult) checkpointResult {
	t.Helper()
	select {
	case outcome := <-result:
		return outcome
	case <-time.After(5 * time.Second):
		t.Fatal("the duplicate checkpoint call never returned")
		return checkpointResult{}
	}
}

func inFlightCheckpoints(handler *HandlerContext) int {
	handler.checkpoint.Lock()
	defer handler.checkpoint.Unlock()
	return len(handler.checkpoints)
}

// requireInFlight confirms the initiator holds the entry, so a duplicate started now coalesces
// instead of starting a call of its own.
func requireInFlight(t *testing.T, handler *HandlerContext, name string) {
	t.Helper()
	handler.checkpoint.Lock()
	defer handler.checkpoint.Unlock()
	if handler.checkpoints[name] == nil {
		t.Fatalf("no in-flight checkpoint %s", name)
	}
}

func TestCheckpointPanicReleasesEveryDuplicate(t *testing.T) {
	handler := newCheckpointHandler(context.Background())
	entered := make(chan struct{})
	release := make(chan struct{})
	panicked := make(chan any, 1)
	go func() {
		defer func() { panicked <- recover() }()
		_, _ = handler.Checkpoint("step", func() (any, error) {
			close(entered)
			<-release
			panic("operation failed")
		})
	}()
	<-entered
	requireInFlight(t, handler, "step")
	duplicates := []<-chan checkpointResult{
		startDuplicate(handler, "step"),
		startDuplicate(handler, "step"),
	}
	// Let both duplicates block on the in-flight entry before the operation panics.
	time.Sleep(100 * time.Millisecond)
	close(release)

	if recovered := <-panicked; recovered != "operation failed" {
		t.Fatalf("the initiator recovered %v, want the operation panic", recovered)
	}
	for _, duplicate := range duplicates {
		outcome := awaitDuplicate(t, duplicate)
		if outcome.err == nil || outcome.err.Error() != "checkpoint step operation panicked" {
			t.Fatalf("a duplicate returned %v, %v; want the panic error", outcome.value, outcome.err)
		}
		if outcome.value != nil {
			t.Fatalf("a duplicate returned value %v", outcome.value)
		}
	}
	if count := inFlightCheckpoints(handler); count != 0 {
		t.Fatalf("%d checkpoint entries remain in flight", count)
	}
}

func TestCheckpointDuplicateReturnsWhenTheHandlerContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	handler := newCheckpointHandler(ctx)
	entered := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	go func() {
		_, _ = handler.Checkpoint("step", func() (any, error) {
			close(entered)
			// The operation ignores cancellation, as application code may.
			<-release
			return "late", nil
		})
	}()
	<-entered
	requireInFlight(t, handler, "step")
	duplicate := startDuplicate(handler, "step")
	// Let the duplicate block on the in-flight entry before the handler context ends.
	time.Sleep(100 * time.Millisecond)
	lost := errors.New("lease lost")
	cancel(lost)

	outcome := awaitDuplicate(t, duplicate)
	if !errors.Is(outcome.err, lost) || outcome.value != nil {
		t.Fatalf("the duplicate returned %v, %v; want the context cause", outcome.value, outcome.err)
	}
}
