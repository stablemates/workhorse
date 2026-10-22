package dashboard

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	workhorse "github.com/stablemates/workhorse/go"
)

// retentionPreviewExecutor records the statement and the arguments of the preview call.
type retentionPreviewExecutor struct {
	statements []string
	arguments  []any
}

func (executor *retentionPreviewExecutor) Query(_ context.Context, statement string, arguments ...any) ([]workhorse.Row, error) {
	executor.statements = append(executor.statements, statement)
	executor.arguments = arguments
	return []workhorse.Row{{"result": `{"eligible":{},"capped":{}}`}}, nil
}

func TestPreviewRetentionPolicyCallsTheDashboardFunctionWithTheInput(t *testing.T) {
	executor := &retentionPreviewExecutor{}
	service := &backend{executor: executor}
	input := map[string]any{"definition": map[string]any{
		"terminalOutcomeRetentionDays": nil,
		"statisticsRetentionDays":      float64(3),
	}}

	if _, err := service.previewRetentionPolicy(context.Background(), input, "operator"); err != nil {
		t.Fatal(err)
	}

	want := []string{"SELECT workhorse.dashboard_retention_preview_v1($1::jsonb) AS result"}
	if !reflect.DeepEqual(executor.statements, want) {
		t.Fatalf("preview statements = %#v, want %#v", executor.statements, want)
	}
	// The function merges the definition, so the explicit null reaches it unchanged.
	var sent map[string]any
	if err := json.Unmarshal([]byte(executor.arguments[0].(string)), &sent); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sent, input) {
		t.Fatalf("preview input = %#v, want %#v", sent, input)
	}
}
