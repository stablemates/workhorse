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

// redriveCounts returns the value of workhorse.tasks.redrive for each workhorse.redrive.status.
// It also checks the kind, the unit, and the description against TypeScript.
func redriveCounts(t *testing.T, reader *sdkmetric.ManualReader) map[string]int64 {
	t.Helper()
	var collected metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &collected); err != nil {
		t.Fatal(err)
	}
	counts := map[string]int64{}
	for _, scope := range collected.ScopeMetrics {
		for _, instrument := range scope.Metrics {
			if instrument.Name != "workhorse.tasks.redrive" {
				continue
			}
			if instrument.Unit != "{request}" || instrument.Description != "Task redrive requests by durable result" {
				t.Errorf("unit = %q, description = %q", instrument.Unit, instrument.Description)
			}
			data, ok := instrument.Data.(metricdata.Sum[int64])
			if !ok || !data.IsMonotonic {
				t.Fatalf("workhorse.tasks.redrive data = %T, want a monotonic int64 sum", instrument.Data)
			}
			for _, point := range data.DataPoints {
				if point.Attributes.Len() != 1 {
					t.Errorf("attributes = %v, want only workhorse.redrive.status", point.Attributes)
				}
				status, _ := point.Attributes.Value("workhorse.redrive.status")
				counts[status.AsString()] += point.Value
			}
		}
	}
	return counts
}

func redriveDatabase(t *testing.T, name string) (context.Context, *pgxpool.Pool) {
	t.Helper()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), name)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return ctx, pool
}

func redriveAudit() workhorse.AdminAudit {
	return workhorse.AdminAudit{Actor: "operator", Reason: "redrive metric", RequestID: uuid.NewString()}
}

// scriptedRedriveFunctions replace redrive_many_v1 with one that answers two rows of a known status
// and one of a status of a newer protocol, and redrive_v1 with one that answers a status of a newer
// protocol. Only a failed task gives real rows, and this SDK does not validate the status.
const scriptedRedriveFunctions = `
	CREATE OR REPLACE FUNCTION workhorse.redrive_many_v1(
	  p_filter jsonb, p_limit integer, p_dry_run boolean, p_requested_by text, p_reason text,
	  p_request_id text, p_cursor_finished_at timestamptz DEFAULT NULL,
	  p_cursor_task_id uuid DEFAULT NULL
	) RETURNS TABLE (
	  ordinal integer, status text, source_task_id uuid, target_task_id uuid, source_state text,
	  target_state text, requested_at timestamptz, source_finished_at_cursor text, has_more boolean
	) LANGUAGE sql AS $body$
	  SELECT row.ordinal, row.status, gen_random_uuid(), NULL::uuid, NULL::text, NULL::text,
	         NULL::timestamptz, NULL::text, false
	  FROM (VALUES (1, 'redriven'), (2, 'future_status'), (3, 'redriven')) AS row(ordinal, status)
	$body$;
	CREATE OR REPLACE FUNCTION workhorse.redrive_v1(
	  p_source_task_id uuid, p_requested_by text, p_reason text, p_request_id text
	) RETURNS TABLE (
	  status text, source_task_id uuid, target_task_id uuid, source_state text, target_state text,
	  requested_at timestamptz
	) LANGUAGE sql AS $body$
	  SELECT 'future_status'::text, p_source_task_id, NULL::uuid, NULL::text, NULL::text,
	         NULL::timestamptz
	$body$`

// Admin.Redrive counts each redrive_v1 result once, by its durable status, as TypeScript does. A
// page without a failed task counts nothing. The meter provider is registered after the admin is
// constructed, so the admin reads it on use.
func TestAdminRedriveCountsEachDurableResult(t *testing.T) {
	ctx, pool := redriveDatabase(t, "go-redrive-metric")
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-redrive-metric")
	admin := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool))
	reader := installMetricReader(t)

	taskID, err := queue.Enqueue(ctx, "redrive-me", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{uuid.NewString(), taskID} {
		if _, err := admin.Redrive(ctx, id, redriveAudit()); err != nil {
			t.Fatal(err)
		}
	}
	page, err := admin.RedriveMany(ctx, workhorse.DeadLetterFilter{Queue: "go-redrive-metric"}, redriveAudit(), workhorse.BulkRedriveOptions{})
	if err != nil || len(page.Results) != 0 {
		t.Fatalf("RedriveMany = %#v, %v; want an empty page", page, err)
	}

	want := map[string]int64{"not_found": 1, "not_failed": 1}
	if got := redriveCounts(t, reader); !maps.Equal(got, want) {
		t.Fatalf("workhorse.tasks.redrive = %v, want %v", got, want)
	}
}

// Admin.RedriveMany counts each status of the page once, with the number of its rows, as
// TypeScript does. A dry run counts its rows too, and the count takes the raw status.
func TestAdminRedriveManyCountsEachResultByItsStatus(t *testing.T) {
	ctx, pool := redriveDatabase(t, "go-redrive-metric-many")
	if _, err := pool.Exec(ctx, scriptedRedriveFunctions); err != nil {
		t.Fatal(err)
	}
	admin := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool))
	reader := installMetricReader(t)

	page, err := admin.RedriveMany(ctx, workhorse.DeadLetterFilter{Queue: "any"}, redriveAudit(), workhorse.BulkRedriveOptions{DryRun: true})
	if err != nil || len(page.Results) != 3 {
		t.Fatalf("RedriveMany = %#v, %v; want three results", page, err)
	}
	if _, err := admin.Redrive(ctx, uuid.NewString(), redriveAudit()); err != nil {
		t.Fatal(err)
	}

	want := map[string]int64{"redriven": 2, "future_status": 2}
	if got := redriveCounts(t, reader); !maps.Equal(got, want) {
		t.Fatalf("workhorse.tasks.redrive = %v, want %v", got, want)
	}
}

// A meter provider that panics changes no redrive result.
func TestAPanickingMeterChangesNoRedriveResult(t *testing.T) {
	ctx, pool := redriveDatabase(t, "go-redrive-metric-panic")
	if _, err := pool.Exec(ctx, scriptedRedriveFunctions); err != nil {
		t.Fatal(err)
	}
	admin := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool))
	previous := otel.GetMeterProvider()
	otel.SetMeterProvider(panickingMeterProvider{})
	t.Cleanup(func() { otel.SetMeterProvider(previous) })

	page, err := admin.RedriveMany(ctx, workhorse.DeadLetterFilter{Queue: "any"}, redriveAudit(), workhorse.BulkRedriveOptions{})
	if err != nil || len(page.Results) != 3 {
		t.Fatalf("RedriveMany = %#v, %v; want three results", page, err)
	}
	result, err := admin.Redrive(ctx, uuid.NewString(), redriveAudit())
	if err != nil || result.Status != "future_status" {
		t.Fatalf("Redrive = %#v, %v; want future_status", result, err)
	}
}
