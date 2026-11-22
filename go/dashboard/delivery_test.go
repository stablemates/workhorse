package dashboard

import (
	"context"
	"encoding/json"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	workhorse "github.com/stablemates/workhorse/go"
)

// deliveryExecutor answers a signal or human-decision delivery with one retained row whose JSON
// column holds cell, the shape a driver hands back for the text the statement selects.
type deliveryExecutor struct {
	status    string
	state     any
	cell      any
	statement string
}

func (executor *deliveryExecutor) Query(_ context.Context, statement string, _ ...any) ([]workhorse.Row, error) {
	executor.statement = statement
	return []workhorse.Row{{
		"status":       executor.status,
		"state":        executor.state,
		"payload":      executor.cell,
		"result":       executor.cell,
		"delivered_at": time.Date(2026, 9, 30, 13, 0, 0, 0, time.UTC),
		"delivered_by": "operator",
		"completed_at": time.Date(2026, 9, 30, 13, 0, 0, 0, time.UTC),
		"completed_by": "operator",
	}}, nil
}

func TestDeliveriesReturnRetainedJSONAsJSON(t *testing.T) {
	values := map[string]any{
		"object":  map[string]any{"approved": true, "note": "ship it"},
		"array":   []any{float64(1), "two", nil},
		"string":  "approved",
		"number":  float64(42),
		"boolean": false,
		"null":    nil,
		// Timestamp-like strings are application data and must not be normalized.
		"timestamp": "2026-09-30T09:00:00.123456-04:00",
		"nested": map[string]any{
			"at":   "2026-09-30T09:00:00.123456-04:00",
			"list": []any{"2026-09-30T13:00:00.000001Z"},
		},
	}
	deliveries := []struct {
		name   string
		column string
		call   func(*backend, context.Context, any, string) (any, error)
	}{
		{"signalTask", "payload", (*backend).signalTask},
		{"completeHumanWait", "result", (*backend).completeHumanWait},
	}
	for _, delivery := range deliveries {
		for _, status := range []string{"delivered", "already_delivered"} {
			for label, want := range values {
				encoded, err := json.Marshal(want)
				if err != nil {
					t.Fatal(err)
				}
				// database/sql over the pgx stdlib driver scans JSON as bytes; text arrives as a string.
				for _, cell := range []any{encoded, string(encoded)} {
					executor := &deliveryExecutor{status: status, cell: cell}
					service := &backend{executor: executor}
					response, err := delivery.call(service, context.Background(), map[string]any{"id": "task-1", "name": "approval", delivery.column: want}, "operator")
					if err != nil {
						t.Fatalf("%s %s %s %T: %v", delivery.name, status, label, cell, err)
					}
					if !strings.Contains(executor.statement, delivery.column+"::text") {
						t.Fatalf("%s selects %s without a text cast: %s", delivery.name, delivery.column, executor.statement)
					}
					got := response.(map[string]any)[delivery.column]
					if !reflect.DeepEqual(got, want) {
						t.Fatalf("%s %s %s %T: %s = %#v, want %#v", delivery.name, status, label, cell, delivery.column, got, want)
					}
				}
			}
		}
	}
}

func TestDeliveryWithoutRetainedJSONReturnsNull(t *testing.T) {
	service := &backend{executor: &deliveryExecutor{status: "not_waiting", cell: nil}}
	response, err := service.signalTask(context.Background(), map[string]any{"id": "task-1", "name": "approval"}, "operator")
	if err != nil {
		t.Fatal(err)
	}
	if payload := response.(map[string]any)["payload"]; payload != nil {
		t.Fatalf("payload = %#v, want nil", payload)
	}
}

// The TypeScript dashboard calls the queue, which writes one record for each cancel, signal, and
// human wait. The Go dashboard runs the statement itself, so it writes the same records.
func TestDashboardDeliveriesWriteTheQueueRecords(t *testing.T) {
	var logs strings.Builder
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	ctx := context.Background()
	cancel := &backend{executor: &deliveryExecutor{status: "canceled", state: "canceled"}}
	if _, err := cancel.cancelTask(ctx, map[string]any{"id": "task-1", "audit": map[string]any{}}, "operator"); err != nil {
		t.Fatal(err)
	}
	signal := &backend{executor: &deliveryExecutor{status: "delivered", cell: `{"secret":"never-log-this"}`}}
	if _, err := signal.signalTask(ctx, map[string]any{"id": "task-1", "name": "approval"}, "operator"); err != nil {
		t.Fatal(err)
	}
	if _, err := signal.completeHumanWait(ctx, map[string]any{"id": "task-1", "name": "review"}, "operator"); err != nil {
		t.Fatal(err)
	}

	want := []map[string]any{
		{"event.name": "workhorse.task.cancellation_processed", "msg": "Task cancellation processed",
			"workhorse.task.id": "task-1", "workhorse.task.state": "canceled", "workhorse.operation.status": "canceled"},
		{"event.name": "workhorse.task.signal_processed", "msg": "Task signal processed",
			"workhorse.task.id": "task-1", "workhorse.signal.name": "approval", "workhorse.signal.status": "delivered"},
		{"event.name": "workhorse.task.human_wait_processed", "msg": "Human wait completion processed",
			"workhorse.task.id": "task-1", "workhorse.human_wait.name": "review", "workhorse.human_wait.status": "delivered"},
	}
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	if len(lines) != len(want) {
		t.Fatalf("got %d records, want %d: %s", len(lines), len(want), logs.String())
	}
	for index, line := range lines {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		if record["level"] != "INFO" {
			t.Errorf("record %d level is %v, want INFO", index, record["level"])
		}
		for key, value := range want[index] {
			if record[key] != value {
				t.Errorf("record %d: %s is %v, want %v: %v", index, key, record[key], value, record)
			}
		}
	}
	if strings.Contains(logs.String(), "never-log-this") {
		t.Fatalf("a record holds the delivered value: %s", logs.String())
	}
}
