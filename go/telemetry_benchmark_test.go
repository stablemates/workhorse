package workhorse

import (
	"context"
	"log/slog"
	"testing"
	"time"
)

func BenchmarkWorkerMetricsNoProvider(b *testing.B) {
	metrics, err := newWorkerMetrics()
	if err != nil {
		b.Fatal(err)
	}
	task := ClaimedTask{Queue: "benchmark", Type: "noop"}
	ctx := context.Background()
	duration := time.Millisecond

	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		metrics.recordHandler(ctx, task, handlerOutcomeSucceeded, duration)
	}
}

func TestLogWorkerEventBuildsNothingForADisabledLogger(t *testing.T) {
	logger := slog.New(discardLogHandler{})
	task := ClaimedTask{ID: "task", Queue: "benchmark", Type: "noop"}
	built := 0
	attributes := func() []any {
		built++
		return taskLogAttributes(task, "worker")
	}
	allocations := testing.AllocsPerRun(100, func() {
		logWorkerEvent(context.Background(), logger, slog.LevelInfo, taskClaimedEvent, taskClaimedLogMessage, attributes)
	})
	if built != 0 {
		t.Fatalf("attributes were built %d times for a disabled logger", built)
	}
	if allocations != 0 {
		t.Fatalf("disabled logger allocated %.0f times per event", allocations)
	}
}

func BenchmarkLogWorkerEventDisabled(b *testing.B) {
	logger := slog.New(discardLogHandler{})
	task := ClaimedTask{ID: "task", Queue: "benchmark", Type: "noop"}
	ctx := context.Background()
	attributes := func() []any { return taskLogAttributes(task, "worker") }
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		logWorkerEvent(ctx, logger, slog.LevelInfo, taskClaimedEvent, taskClaimedLogMessage, attributes)
	}
}
