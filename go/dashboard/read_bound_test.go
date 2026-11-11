package dashboard

import (
	"context"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	workhorse "github.com/stablemates/workhorse/go"
)

func TestHandlerRefusesAStatementTimeoutUnderOneMillisecond(t *testing.T) {
	for _, timeout := range []time.Duration{-time.Second, time.Microsecond} {
		_, err := NewHandler(HandlerOptions{
			Executor:         rejectingExecutor{},
			Authorize:        func(*http.Request) Authorization { return Authorization{} },
			StatementTimeout: timeout,
		})
		if err == nil || !strings.Contains(err.Error(), "statement timeout") {
			t.Fatalf("timeout %s: err = %v", timeout, err)
		}
	}
}

type recordingExecutor struct{ statements *[]string }

func (executor recordingExecutor) Query(_ context.Context, statement string, _ ...any) ([]workhorse.Row, error) {
	*executor.statements = append(*executor.statements, statement)
	return []workhorse.Row{{"result": "{}"}}, nil
}

// An Executor that this module did not make has no connection to lend, so its reads run directly.
func TestABoundedReadThroughAnotherExecutorRunsDirectly(t *testing.T) {
	var statements []string
	reader := newBoundedReader(recordingExecutor{statements: &statements}, time.Second)
	if _, err := reader.Query(context.Background(), "SELECT 1 AS result"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(statements, []string{"SELECT 1 AS result"}) {
		t.Fatalf("statements = %#v", statements)
	}
}

func TestDropUndeclaredKeysKeepsOnlyTheContractInput(t *testing.T) {
	system := dropUndeclaredKeys("system", map[string]any{"window": "1h", "health": map[string]any{}})
	if !reflect.DeepEqual(system, map[string]any{"window": "1h"}) {
		t.Fatalf("system = %#v", system)
	}
	payload := map[string]any{"health": map[string]any{}, "nested": map[string]any{"anyKey": []any{1.0}}}
	signal := dropUndeclaredKeys("signalTask", map[string]any{
		"id": "00000000-0000-4000-8000-00000000dead", "name": "approval", "payload": payload,
		"idempotencyKey": "key-1", "undeclared": true,
		"audit": map[string]any{"actor": "a", "reason": "r", "requestId": "q", "extra": 1},
	}).(map[string]any)
	if _, ok := signal["undeclared"]; ok {
		t.Fatalf("signal kept an undeclared key: %#v", signal)
	}
	if !reflect.DeepEqual(signal["payload"], payload) {
		t.Fatalf("payload = %#v", signal["payload"])
	}
	if !reflect.DeepEqual(signal["audit"], map[string]any{"actor": "a", "reason": "r", "requestId": "q"}) {
		t.Fatalf("audit = %#v", signal["audit"])
	}
}
