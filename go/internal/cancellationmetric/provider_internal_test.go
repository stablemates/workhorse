package cancellationmetric

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// The check uses the type of the global delegate. A provider that the process registered, also
// before this package started, is not the delegate, so Record counts through it.
func TestOnlyTheGlobalDelegateIsTheInitialProvider(t *testing.T) {
	if !isInitialProvider(otel.GetMeterProvider()) {
		t.Fatalf("the global delegate %T is not the initial provider", otel.GetMeterProvider())
	}
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	otel.SetMeterProvider(provider)
	if isInitialProvider(otel.GetMeterProvider()) {
		t.Fatal("a registered provider is the initial provider")
	}

	Record(context.Background(), "accepted")

	var collected metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &collected); err != nil {
		t.Fatal(err)
	}
	count := int64(0)
	for _, scope := range collected.ScopeMetrics {
		for _, instrument := range scope.Metrics {
			if sum, ok := instrument.Data.(metricdata.Sum[int64]); ok && instrument.Name == instrumentName {
				for _, point := range sum.DataPoints {
					count += point.Value
				}
			}
		}
	}
	if count != 1 {
		t.Fatalf("workhorse.tasks.cancellation = %d, want 1", count)
	}
}
