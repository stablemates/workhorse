package dashboard

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	workhorse "github.com/stablemates/workhorse/go"
)

// healthExecutor answers the health read with a sentinel document and records every statement
// with its first argument, so a test can see what each procedure handed to PostgreSQL.
type healthExecutor struct {
	statements []string
	inputs     []string
}

func (executor *healthExecutor) Query(_ context.Context, statement string, arguments ...any) ([]workhorse.Row, error) {
	executor.statements = append(executor.statements, statement)
	if len(arguments) > 0 {
		executor.inputs = append(executor.inputs, arguments[0].(string))
	}
	if strings.Contains(statement, "queue_health_v1()") {
		return []workhorse.Row{{"result": `{"level":"healthy","pending_human_waits":42}`}}, nil
	}
	return []workhorse.Row{{"result": `{"ok":true}`}}, nil
}

func TestHumanWaitsAndTaskDetailShareOneHealthDocument(t *testing.T) {
	executor := &healthExecutor{}
	service := &backend{executor: executor}

	if _, err := service.humanWaits(context.Background(), nil, "operator"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.taskDetail(context.Background(), map[string]any{"id": "task-1"}, "operator"); err != nil {
		t.Fatal(err)
	}

	healthReads := 0
	for _, statement := range executor.statements {
		if strings.Contains(statement, "queue_health_v1()") {
			healthReads++
		}
	}
	if healthReads != 1 {
		t.Fatalf("health document read %d times across two procedures, want 1", healthReads)
	}
	if len(executor.inputs) != 2 {
		t.Fatalf("procedure inputs = %d, want 2", len(executor.inputs))
	}
	for _, input := range executor.inputs {
		var decoded map[string]any
		if err := json.Unmarshal([]byte(input), &decoded); err != nil {
			t.Fatal(err)
		}
		health, ok := decoded["health"].(map[string]any)
		if !ok || health["pending_human_waits"] != float64(42) {
			t.Fatalf("procedure input carries no health document: %s", input)
		}
	}
}
