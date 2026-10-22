package dashboard

import (
	"context"
)

func (service *backend) cron(ctx context.Context, _ any, _ string) (any, error) {
	return service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_cron_v1($1::jsonb) AS result",
		string(mustJSON(map[string]any{"maintenanceLoops": service.maintenanceLoops})),
	)
}

func (service *backend) workers(ctx context.Context, _ any, _ string) (any, error) {
	workers := service.configuredWorkers
	if workers == nil {
		workers = []string{}
	}
	return service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_workers_v1($1::jsonb) AS result",
		string(mustJSON(map[string]any{
			"configuredWorkers": workers,
			"canManageWorkers":  !service.readOnly,
		})),
	)
}

func (service *backend) humanWaits(ctx context.Context, _ any, _ string) (any, error) {
	health, err := service.queueHealth(ctx)
	if err != nil {
		return nil, err
	}
	input := string(mustJSON(map[string]any{
		"canComplete": !service.readOnly,
		"canSignal":   !service.readOnly,
		"health":      health,
	}))
	return service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_human_waits_v1($1::jsonb) AS result",
		input,
	)
}

func (service *backend) events(ctx context.Context, input any, _ string) (any, error) {
	return service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_events_v1($1::jsonb) AS result",
		string(mustJSON(input)),
	)
}

func (service *backend) eventDetail(ctx context.Context, input any, _ string) (any, error) {
	rows, err := service.executor.Query(
		ctx,
		"SELECT workhorse.dashboard_event_detail_v1($1::jsonb) AS result",
		string(mustJSON(input)),
	)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 || rows[0]["result"] == nil {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Event not found"}
	}
	return decodeJSONCell(rows[0]["result"])
}

func (service *backend) tasks(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	defaults := map[string]any{
		"filter": "all", "queue": nil, "page": 1, "worker": nil, "taskType": nil,
		"priority": nil, "sort": "updated", "tags": []any{}, "search": nil, "pageSize": 50,
		"count": "none",
	}
	for key, defaultValue := range defaults {
		if _, exists := value[key]; !exists {
			value[key] = defaultValue
		}
	}
	value["canCompleteHumanWait"] = !service.readOnly
	return service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_tasks_v1($1::jsonb) AS result",
		string(mustJSON(value)),
	)
}

func (service *backend) activity(ctx context.Context, input any, _ string) (any, error) {
	return service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_activity_v1($1::jsonb) AS result",
		string(mustJSON(input)),
	)
}

func (service *backend) previewRetentionPolicy(ctx context.Context, input any, _ string) (any, error) {
	// The function merges the definition into the current policy and caps each count.
	return service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_retention_preview_v1($1::jsonb) AS result",
		string(mustJSON(input)),
	)
}

func (service *backend) taskDetail(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	health, err := service.queueHealth(ctx)
	if err != nil {
		return nil, err
	}
	value["canSignal"] = !service.readOnly
	value["canCompleteHumanWait"] = !service.readOnly
	value["health"] = health
	result, err := service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_task_detail_v1($1::jsonb) AS result",
		string(mustJSON(value)),
	)
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Task not found"}
	}
	return result, nil
}

// checkpointValue reads one saved checkpoint value. Task detail withholds a value larger than it
// carries inline and reports its size, so an operator opens that one value here.
func (service *backend) checkpointValue(ctx context.Context, input any, _ string) (any, error) {
	result, err := service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_checkpoint_value_v1($1::jsonb) AS result",
		string(mustJSON(input)),
	)
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Checkpoint not found"}
	}
	return result, nil
}

// taskValue reads one task's whole payload or result. Task detail withholds either one when it is
// larger than it carries inline and reports its size, so an operator opens that one value here.
func (service *backend) taskValue(ctx context.Context, input any, _ string) (any, error) {
	result, err := service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_task_value_v1($1::jsonb) AS result",
		string(mustJSON(input)),
	)
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Task not found"}
	}
	return result, nil
}

func (service *backend) settings(ctx context.Context, _ any, _ string) (any, error) {
	return service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_settings_v1($1::jsonb) AS result",
		string(mustJSON(map[string]any{
			"writable": !service.readOnly, "settingsController": true,
		})),
	)
}

func (service *backend) tasksCursor(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	value["canCompleteHumanWait"] = !service.readOnly
	return service.jsonQuery(ctx, "SELECT workhorse.dashboard_tasks_cursor_v1($1::jsonb) AS result", string(mustJSON(value)))
}
