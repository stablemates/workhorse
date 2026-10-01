package dashboard

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	workhorse "github.com/stablemates/workhorse/go"
)

// Each projection carries timestamp-shaped strings an application or Workhorse wrote. SQL already
// formats dashboard metadata, so the backend must return these exactly as stored.
const storedValues = `{
	"value": {"at": "2026-09-30T09:00:00.123456-04:00", "window": ["2026-09-30T09:00:00Z", "1999-12-31T23:59:59.999999999+14:00"]},
	"details": {"run_at": "2026-09-30T09:00:00.5-04:00"}
}`

type storedValueExecutor struct{}

func (storedValueExecutor) Query(context.Context, string, ...any) ([]workhorse.Row, error) {
	return []workhorse.Row{{"result": []byte(storedValues)}}, nil
}

func TestDashboardReturnsStoredValuesUnchanged(t *testing.T) {
	// encoding/json decodes the expectation so it cannot share a rewrite with the decoder under test.
	var want any
	if err := json.Unmarshal([]byte(storedValues), &want); err != nil {
		t.Fatal(err)
	}
	service := &backend{executor: storedValueExecutor{}}
	reads := map[string]func(context.Context, any, string) (any, error){
		"taskValue":       service.taskValue,
		"checkpointValue": service.checkpointValue,
		"taskDetail":      service.taskDetail,
		"eventDetail":     service.eventDetail,
	}
	for name, read := range reads {
		got, err := read(context.Background(), map[string]any{}, "operator")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s rewrote a stored value: got %v, want %v", name, got, want)
		}
	}
}
