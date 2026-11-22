package workhorse_test

import (
	"context"
	"maps"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// cancellationCounts returns the value of workhorse.tasks.cancellation for each
// workhorse.cancellation.status. It also checks the unit and the description against TypeScript.
func cancellationCounts(t *testing.T, reader *sdkmetric.ManualReader) map[string]int64 {
	t.Helper()
	var collected metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &collected); err != nil {
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
			data, ok := instrument.Data.(metricdata.Sum[int64])
			if !ok || !data.IsMonotonic {
				t.Fatalf("workhorse.tasks.cancellation data = %T, want a monotonic int64 sum", instrument.Data)
			}
			for _, point := range data.DataPoints {
				if point.Attributes.Len() != 1 {
					t.Errorf("attributes = %v, want only workhorse.cancellation.status", point.Attributes)
				}
				status, _ := point.Attributes.Value("workhorse.cancellation.status")
				counts[status.AsString()] += point.Value
			}
		}
	}
	return counts
}

func cancellationQueue(t *testing.T, name string) (context.Context, *workhorse.Queue) {
	t.Helper()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), name)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return ctx, workhorse.NewQueue(workhorse.NewPGXExecutor(pool), name)
}

// Queue.Cancel counts each cancel_v1 result once, by its durable status, as TypeScript does. The
// meter provider is registered after the queue is constructed, so the queue reads it on use.
func TestQueueCancelCountsEachDurableResult(t *testing.T) {
	ctx, queue := cancellationQueue(t, "go-cancellation-metric")
	reader := installMetricReader(t)

	taskID, err := queue.Enqueue(ctx, "cancel-me", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{taskID, uuid.NewString()} {
		if _, err := queue.Cancel(ctx, id, workhorse.CancellationRequest{}); err != nil {
			t.Fatal(err)
		}
	}

	want := map[string]int64{"canceled": 1, "not_found": 1}
	if got := cancellationCounts(t, reader); !maps.Equal(got, want) {
		t.Fatalf("workhorse.tasks.cancellation = %v, want %v", got, want)
	}
}

// A meter provider that panics changes no cancel result.
func TestAPanickingMeterChangesNoCancelResult(t *testing.T) {
	ctx, queue := cancellationQueue(t, "go-cancellation-metric-panic")
	previous := otel.GetMeterProvider()
	otel.SetMeterProvider(panickingMeterProvider{})
	t.Cleanup(func() { otel.SetMeterProvider(previous) })

	result, err := queue.Cancel(ctx, uuid.NewString(), workhorse.CancellationRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != workhorse.CancelNotFound {
		t.Fatalf("status = %q, want not_found", result.Status)
	}
}

// futureCancelStatusFunction replaces cancel_v1 with one that answers a status that this SDK does
// not know, as a newer protocol could.
const futureCancelStatusFunction = `
	CREATE OR REPLACE FUNCTION workhorse.cancel_v1(
	  p_task_id uuid, p_requested_by text DEFAULT NULL, p_reason text DEFAULT NULL
	) RETURNS TABLE (
	  status text, state text, current_attempt integer, requested_at timestamptz,
	  requested_by text, reason text, finished_at timestamptz
	) LANGUAGE sql AS $body$
	  SELECT 'future_status'::text, NULL::text, NULL::integer, NULL::timestamptz, NULL::text,
	         NULL::text, NULL::timestamptz
	$body$`

// cancel_v1 answers a status of a newer protocol. As TypeScript does, Queue.Cancel counts the raw
// status before it rejects the result. Before, the Go queue counted nothing.
func TestQueueCancelCountsAStatusOfANewerProtocol(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "go-cancellation-metric-future")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, futureCancelStatusFunction); err != nil {
		t.Fatal(err)
	}
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-cancellation-metric-future")
	reader := installMetricReader(t)

	if _, err := queue.Cancel(ctx, uuid.NewString(), workhorse.CancellationRequest{}); err == nil {
		t.Fatal("Cancel accepted a status that the Go SDK does not know")
	}

	want := map[string]int64{"future_status": 1}
	if got := cancellationCounts(t, reader); !maps.Equal(got, want) {
		t.Fatalf("workhorse.tasks.cancellation = %v, want %v", got, want)
	}
}
