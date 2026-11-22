package dashboard

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// The TypeScript dashboard calls the queue, which counts each cancel_v1 result. The Go dashboard
// runs the statement itself, so it counts the same result, a missing task too.
func TestDashboardCancelCountsTheDurableResult(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	previous := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		otel.SetMeterProvider(previous)
		_ = provider.Shutdown(context.Background())
	})

	ctx := context.Background()
	input := map[string]any{"id": "task-1", "audit": map[string]any{}}
	canceled := &backend{executor: &deliveryExecutor{status: "canceled", state: "canceled"}}
	if _, err := canceled.cancelTask(ctx, input, "operator"); err != nil {
		t.Fatal(err)
	}
	missing := &backend{executor: &deliveryExecutor{status: "not_found"}}
	if _, err := missing.cancelTask(ctx, input, "operator"); err == nil {
		t.Fatal("cancelTask() of a missing task returned no error")
	}

	var collected metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &collected); err != nil {
		t.Fatal(err)
	}
	counts := map[string]int64{}
	for _, scope := range collected.ScopeMetrics {
		for _, instrument := range scope.Metrics {
			if instrument.Name != "workhorse.tasks.cancellation" {
				continue
			}
			if instrument.Unit != "{request}" || instrument.Description != "Task cancellation requests by durable result" {
				t.Errorf("unit = %q, description = %q", instrument.Unit, instrument.Description)
			}
			for _, point := range instrument.Data.(metricdata.Sum[int64]).DataPoints {
				status, _ := point.Attributes.Value("workhorse.cancellation.status")
				counts[status.AsString()] += point.Value
			}
		}
	}
	if counts["canceled"] != 1 || counts["not_found"] != 1 || len(counts) != 2 {
		t.Fatalf("workhorse.tasks.cancellation = %v, want canceled 1 and not_found 1", counts)
	}
}
