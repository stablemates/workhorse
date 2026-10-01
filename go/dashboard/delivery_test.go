package dashboard

import (
	"context"
	"encoding/json"
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
	cell      any
	statement string
}

func (executor *deliveryExecutor) Query(_ context.Context, statement string, _ ...any) ([]workhorse.Row, error) {
	executor.statement = statement
	return []workhorse.Row{{
		"status":       executor.status,
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
