package dashboard

import (
	"context"
	"testing"

	workhorse "github.com/stablemates/workhorse/go"
)

type cursorExecutor struct{}

func (cursorExecutor) Query(context.Context, string, ...any) ([]workhorse.Row, error) {
	return []workhorse.Row{{"result": `{"total":null,"nextCursor":{"id":"01890abc-0000-7000-8000-000000000001","priority":0,"updatedAt":"2026-09-08T01:02:03.123000Z"}}`}}, nil
}

func TestTaskCursorPreservesDatabasePrecision(t *testing.T) {
	service := &backend{executor: cursorExecutor{}}
	value, err := service.tasksCursor(context.Background(), map[string]any{}, "operator")
	if err != nil {
		t.Fatal(err)
	}
	result := value.(map[string]any)
	cursor := result["nextCursor"].(map[string]any)
	if cursor["updatedAt"] != "2026-09-08T01:02:03.123000Z" {
		t.Fatalf("cursor timestamp was rounded: %v", cursor["updatedAt"])
	}
	if issues := ValidateTasksCursorInput(map[string]any{"cursor": cursor}); issues != nil {
		t.Fatalf("returned cursor cannot be passed back: %v", issues)
	}
}
