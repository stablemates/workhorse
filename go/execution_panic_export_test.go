package workhorse

import (
	"context"
	"sync/atomic"

	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/metric/noop"
)

// armedClaimCounter is a raw claimed counter that panics on the first Add after it is armed. It is
// not behind the recovering wrapper, so the code around the instrument meets the panic.
type armedClaimCounter struct {
	noop.Int64Counter
	armed *atomic.Bool
	fired *atomic.Bool
}

func (counter armedClaimCounter) Add(context.Context, int64, ...otelmetric.AddOption) {
	if counter.armed.CompareAndSwap(true, false) {
		counter.fired.Store(true)
		panic("the claimed counter failed")
	}
}

// ArmClaimMetricPanicForTest gives worker metrics that record nothing, with a claimed counter that
// panics once on the first Add after arm. fired reports whether it panicked. Call it before Run.
func ArmClaimMetricPanicForTest(worker *Worker) (arm func(), fired func() bool) {
	armed, panicked := &atomic.Bool{}, &atomic.Bool{}
	worker.metrics = &workerMetrics{
		enabled:                true,
		claimed:                armedClaimCounter{armed: armed, fired: panicked},
		completed:              noop.Int64Counter{},
		failed:                 noop.Int64Counter{},
		retried:                noop.Int64Counter{},
		expiredLeases:          noop.Int64Counter{},
		claimDuration:          noop.Float64Histogram{},
		handlerDuration:        noop.Float64Histogram{},
		handlerRuntime:         noop.Float64Counter{},
		handlerExecutions:      noop.Int64Counter{},
		batchSize:              noop.Int64Histogram{},
		batchLinger:            noop.Float64Histogram{},
		heartbeatFailures:      noop.Int64Counter{},
		heartbeatRoundFailures: noop.Int64Counter{},
	}
	return func() { armed.Store(true) }, panicked.Load
}
