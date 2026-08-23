package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

func document(input any) (map[string]any, error) {
	value, ok := input.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("dashboard input is not an object")
	}
	return value, nil
}

func (service *backend) setQueuePaused(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	function := "pause_queue_v1"
	if paused, _ := value["paused"].(bool); !paused {
		function = "resume_queue_v1"
	}
	_, err := service.executor.Query(ctx, "SELECT workhorse."+function+"($1::text)", value["queue"])
	return map[string]any{"paused": value["paused"]}, err
}

func (service *backend) purgeQueue(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	rows, err := service.executor.Query(ctx, "SELECT workhorse.purge_queue_v1($1::text)::integer AS count", value["queue"])
	if err != nil {
		return nil, err
	}
	return map[string]any{"deletedCount": rows[0]["count"]}, nil
}

func (service *backend) setWorkerPaused(ctx context.Context, input any, actor string) (any, error) {
	value, _ := document(input)
	audit, _ := value["audit"].(map[string]any)
	rows, err := service.executor.Query(ctx, `SELECT paused FROM workhorse.set_worker_paused_v1($1::text,$2::boolean,$3::text,$4::text)`, value["workerId"], value["paused"], actor, audit["reason"])
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Worker not found"}
	}
	return map[string]any{"paused": rows[0]["paused"]}, nil
}

func (service *backend) overrideMaintenancePolicy(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	definition, _ := value["definition"].(map[string]any)
	_, err := service.executor.Query(ctx, `SELECT (policy).* FROM workhorse.override_maintenance_policy_v1($1::text,$2::integer,$3::integer,$4::time,$5::integer,$6::integer,$7::integer) policy`, definition["timezone"], definition["partitionPreparationIntervalMs"], definition["terminalCleanupIntervalMs"], definition["historyRetentionLocalTime"], definition["statisticsRollupIntervalMs"], definition["statisticsGroupLimit"], definition["statisticsRecomputeBuckets"])
	return nil, err
}

func snake(value string) string {
	var result strings.Builder
	for _, character := range value {
		if character >= 'A' && character <= 'Z' {
			result.WriteByte('_')
			character += 'a' - 'A'
		}
		result.WriteRune(character)
	}
	return result.String()
}

func stringSlice(value any) []string {
	items, _ := value.([]any)
	result := make([]string, 0, len(items))
	for _, item := range items {
		result = append(result, snake(item.(string)))
	}
	return result
}

func (service *backend) revertMaintenancePolicy(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	_, err := service.executor.Query(ctx, "SELECT (policy).* FROM workhorse.revert_maintenance_policy_v1($1::text[]) policy", stringSlice(value["settings"]))
	return nil, err
}

func (service *backend) overrideRetentionPolicy(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	definition := value["definition"].(map[string]any)
	converted := make(map[string]any, len(definition))
	for key, item := range definition {
		converted[snake(key)] = item
	}
	payload, _ := json.Marshal(converted)
	_, err := service.executor.Query(ctx, "SELECT (policy).* FROM workhorse.override_retention_policy_v1($1::jsonb) policy", payload)
	return nil, err
}

func (service *backend) revertRetentionPolicy(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	_, err := service.executor.Query(ctx, "SELECT (policy).* FROM workhorse.revert_retention_policy_v1($1::text[]) policy", stringSlice(value["settings"]))
	return nil, err
}

func (service *backend) runTaskNow(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	rows, err := service.executor.Query(ctx, "SELECT status,state,run_at FROM workhorse.run_task_now_v1($1::uuid)", value["id"])
	if err != nil {
		return nil, err
	}
	row := rows[0]
	if row["status"] == "not_found" {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Task not found"}
	}
	return map[string]any{"status": row["status"], "id": value["id"], "state": row["state"], "runAt": timestamp(row["run_at"])}, nil
}

func (service *backend) cancelTask(ctx context.Context, input any, actor string) (any, error) {
	value, _ := document(input)
	audit := value["audit"].(map[string]any)
	rows, err := service.executor.Query(ctx, "SELECT status,state,current_attempt,requested_at,requested_by,reason,finished_at FROM workhorse.cancel_v1($1::uuid,$2::text,$3::text)", value["id"], actor, audit["reason"])
	if err != nil {
		return nil, err
	}
	row := rows[0]
	if row["status"] == "not_found" {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Task not found"}
	}
	return map[string]any{"status": row["status"], "jobId": value["id"], "state": row["state"], "currentAttempt": row["current_attempt"], "requestedAt": timestamp(row["requested_at"]), "requestedBy": row["requested_by"], "reason": row["reason"], "finishedAt": timestamp(row["finished_at"])}, nil
}

func (service *backend) signalTask(ctx context.Context, input any, actor string) (any, error) {
	value, _ := document(input)
	payload, _ := json.Marshal(value["payload"])
	rows, err := service.executor.Query(ctx, "SELECT status,payload,delivered_at,delivered_by FROM workhorse.send_signal_v1($1::uuid,$2::text,$3::jsonb,$4::text,$5::text)", value["id"], value["name"], payload, value["idempotencyKey"], actor)
	if err != nil {
		return nil, err
	}
	row := rows[0]
	if row["status"] == "not_found" {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Task not found"}
	}
	return map[string]any{"status": row["status"], "jobId": value["id"], "name": value["name"], "payload": row["payload"], "deliveredAt": timestamp(row["delivered_at"]), "deliveredBy": row["delivered_by"]}, nil
}

func (service *backend) completeHumanWait(ctx context.Context, input any, actor string) (any, error) {
	value, _ := document(input)
	payload, _ := json.Marshal(value["result"])
	rows, err := service.executor.Query(ctx, "SELECT status,result,completed_at,completed_by FROM workhorse.complete_human_wait_v1($1::uuid,$2::text,$3::jsonb,$4::text,$5::text)", value["id"], value["name"], payload, value["idempotencyKey"], actor)
	if err != nil {
		return nil, err
	}
	row := rows[0]
	if row["status"] == "not_found" {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Task not found"}
	}
	return map[string]any{"status": row["status"], "jobId": value["id"], "name": value["name"], "result": row["result"], "completedAt": timestamp(row["completed_at"]), "completedBy": row["completed_by"]}, nil
}
