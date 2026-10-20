package dashboard

import (
	"context"
	"reflect"
	"strings"
	"testing"

	workhorse "github.com/stablemates/workhorse/go"
)

// retentionPreviewExecutor answers the policy read with 14 days for every setting and records the
// arguments of the preview statement.
type retentionPreviewExecutor struct {
	statement string
	arguments []any
}

func (executor *retentionPreviewExecutor) Query(_ context.Context, statement string, arguments ...any) ([]workhorse.Row, error) {
	if strings.Contains(statement, "get_retention_policy_v1()") {
		row := workhorse.Row{}
		for _, column := range []string{"task_identity_retention_days", "terminal_outcome_retention_days", "task_event_retention_days", "attempt_history_retention_days", "schedule_occurrence_retention_days", "statistics_retention_days"} {
			row[column] = int32(14)
		}
		return []workhorse.Row{row}, nil
	}
	executor.statement = statement
	executor.arguments = arguments
	return []workhorse.Row{{"result": `{"eligible":{},"capped":{}}`}}, nil
}

func TestPreviewRetentionPolicySendsTheSharedStatementAndKeepsAnExplicitNull(t *testing.T) {
	executor := &retentionPreviewExecutor{}
	service := &backend{executor: executor}
	input := map[string]any{"definition": map[string]any{
		"terminalOutcomeRetentionDays": nil,
		"statisticsRetentionDays":      float64(3),
	}}

	if _, err := service.previewRetentionPolicy(context.Background(), input, "operator"); err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(executor.statement, retentionPolicyPreviewStatement) {
		t.Fatalf("preview did not send the shared retention_policy_preview statement:\n%s", executor.statement)
	}
	// An absent setting keeps the current value. The explicit null stays null, so the statement
	// counts no terminal tasks.
	want := []any{int32(14), nil, int32(14), int32(14), int32(14), float64(3)}
	if !reflect.DeepEqual(executor.arguments, want) {
		t.Fatalf("preview arguments = %#v, want %#v", executor.arguments, want)
	}
}
