package workhorse

import (
	"context"
	"errors"
	"testing"
	"time"

	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/metric/noop"
)

// panickingInt64Histogram is a raw instrument whose Record panics. The tests put it behind the
// recovering wrapper of the worker, so the code around the instrument meets the panic.
type panickingInt64Histogram struct{ noop.Int64Histogram }

func (panickingInt64Histogram) Record(context.Context, int64, ...otelmetric.RecordOption) {
	panic("the meter failed")
}

// SM-1938: the batch dispatch runs telemetry before the batch handler. If that code panicked, the
// dispatching member failed, and each other member of the batch waited until the stop. The
// dispatch now gives each member without a result the panic as a HandlerPanicError.
func TestBatchDispatchAnswersEachMemberWhenItPanicsOutsideTheBatchHandler(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{Concurrency: 2})
	worker.metrics = &workerMetrics{
		enabled: true, batchSize: panickingInt64Histogram{}, batchLinger: noop.Float64Histogram{},
	}
	called := false
	coordinator := &batchCoordinator{
		worker: worker, taskType: "batch", options: BatchHandlerOptions{MaxSize: 2, Linger: time.Minute},
		pending: make(map[string][]*batchMember),
		handler: func(items []BatchHandlerItem) []BatchHandlerOutcome {
			called = true
			return make([]BatchHandlerOutcome, len(items))
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	results := make(chan error, 2)
	for _, id := range []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"} {
		handlerContext := &HandlerContext{Task: ClaimedTask{ID: id, Type: "batch", Queue: "defaults"}, context: ctx}
		go func() {
			_, err := coordinator.handle(ctx, nil, handlerContext)
			results <- err
		}()
	}
	for range 2 {
		err := awaitSignal(t, results, "each member of the batch to return", cancel)
		var panicked *HandlerPanicError
		if !errors.As(err, &panicked) ||
			err.Error() != "batch dispatch for batch panicked outside the batch handler: the meter failed" {
			t.Fatalf("a member returned %v, want the panic of the dispatch", err)
		}
	}
	if called {
		t.Fatal("the batch handler ran after the dispatch panicked")
	}
}
