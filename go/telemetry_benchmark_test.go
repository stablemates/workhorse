package workhorse

import (
	"context"
	"testing"
	"time"
)

func BenchmarkWorkerMetricsNoProvider(b *testing.B) {
	metrics, err := newWorkerMetrics()
	if err != nil {
		b.Fatal(err)
	}
	job := ClaimedJob{Queue: "benchmark", Type: "noop"}
	ctx := context.Background()
	duration := time.Millisecond

	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		metrics.recordHandler(ctx, job, handlerOutcomeSucceeded, duration)
	}
}
