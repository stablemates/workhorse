package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	workhorse "github.com/stablemates/workhorse/go"
)

func document(input any) (map[string]any, error) {
	value, ok := input.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("dashboard input is not an object")
	}
	return value, nil
}

func adminAudit(value map[string]any, actor string) workhorse.AdminAudit {
	audit, _ := value["audit"].(map[string]any)
	reason, _ := audit["reason"].(string)
	requestID, _ := audit["requestId"].(string)
	return workhorse.AdminAudit{Actor: actor, Reason: reason, RequestID: requestID}
}

func (service *backend) setQueuePaused(ctx context.Context, input any, actor string) (any, error) {
	value, _ := document(input)
	paused, _ := value["paused"].(bool)
	var err error
	if paused {
		err = service.admin.PauseQueue(ctx, fmt.Sprint(value["queue"]), adminAudit(value, actor))
	} else {
		err = service.admin.ResumeQueue(ctx, fmt.Sprint(value["queue"]), adminAudit(value, actor))
	}
	return map[string]any{"paused": paused}, err
}

func (service *backend) purgeQueue(ctx context.Context, input any, actor string) (any, error) {
	value, _ := document(input)
	count, err := service.admin.PurgeQueue(ctx, fmt.Sprint(value["queue"]), adminAudit(value, actor))
	if err != nil {
		return nil, err
	}
	return map[string]any{"deletedCount": count}, nil
}

func (service *backend) setWorkerPaused(ctx context.Context, input any, actor string) (any, error) {
	value, _ := document(input)
	paused, _ := value["paused"].(bool)
	result, err := service.admin.SetWorkerPaused(ctx, fmt.Sprint(value["workerId"]), paused, adminAudit(value, actor))
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Worker not found"}
	}
	return map[string]any{"paused": result.Paused}, nil
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

func (service *backend) runTaskNow(ctx context.Context, input any, actor string) (any, error) {
	value, _ := document(input)
	audit := value["audit"].(map[string]any)
	rows, err := service.executor.Query(ctx, "SELECT status,state,run_at FROM workhorse.run_task_now_v1($1::uuid,$2::text,$3::text,$4::text)", value["id"], actor, audit["reason"], audit["requestId"])
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

// PostgreSQL returns a bulk redrive cursor as exact microsecond text, and every backend has to
// hand back the same characters: a cursor rounded to the millisecond every other dashboard
// timestamp uses would point just before the page it already redrove, and the next page would
// redrive that row a second time.
const redriveCursorLayout = "2006-01-02T15:04:05.000000Z"

// The listing sends tags exactly as an operator selected them, so unlike a policy setting name
// they cross the boundary unchanged.
func tagSlice(value any) []string {
	items, _ := value.([]any)
	result := make([]string, 0, len(items))
	for _, item := range items {
		if tag, ok := item.(string); ok {
			result = append(result, tag)
		}
	}
	return result
}

// The contract bounds the batch and supplies its default, so a decoded number only has to survive
// the JSON round trip that made it a json.Number.
func redriveLimit(value any) int {
	number, ok := value.(json.Number)
	if !ok {
		return 100
	}
	limit, err := number.Int64()
	if err != nil {
		return 100
	}
	return int(limit)
}

func redriveResult(result workhorse.RedriveResult) map[string]any {
	value := map[string]any{
		"status":      result.Status,
		"sourceJobId": result.SourceJobID,
		"targetJobId": nil,
		"sourceState": nil,
		"targetState": nil,
		"requestedAt": nil,
	}
	if result.TargetJobID != nil {
		value["targetJobId"] = *result.TargetJobID
	}
	if result.SourceState != nil {
		value["sourceState"] = string(*result.SourceState)
	}
	if result.TargetState != nil {
		value["targetState"] = string(*result.TargetState)
	}
	if result.RequestedAt != nil {
		value["requestedAt"] = timestamp(*result.RequestedAt)
	}
	return value
}

func (service *backend) redriveTask(ctx context.Context, input any, actor string) (any, error) {
	value, _ := document(input)
	result, err := service.admin.Redrive(ctx, fmt.Sprint(value["id"]), adminAudit(value, actor))
	if err != nil {
		return nil, err
	}
	if result.Status == "not_found" {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Task not found"}
	}
	return redriveResult(result), nil
}

func (service *backend) redriveDeadLetters(ctx context.Context, input any, actor string) (any, error) {
	value, _ := document(input)
	filter := workhorse.DeadLetterFilter{Tags: tagSlice(value["tags"])}
	if queue, ok := value["queue"].(string); ok {
		filter.Queue = queue
	}
	if jobType, ok := value["jobType"].(string); ok {
		filter.Type = jobType
	}
	options := workhorse.BulkRedriveOptions{Limit: redriveLimit(value["limit"])}
	if cursor, ok := value["cursor"].(map[string]any); ok {
		finished, err := time.Parse(time.RFC3339Nano, fmt.Sprint(cursor["finishedAt"]))
		if err != nil {
			return nil, &RPCError{
				Status: 400, Code: "BAD_REQUEST", Message: "Redrive cursor is not a timestamp",
			}
		}
		options.Cursor = &workhorse.AdminCursor{
			OccurredAt: finished,
			JobID:      fmt.Sprint(cursor["jobId"]),
		}
	}
	page, err := service.admin.RedriveMany(ctx, filter, adminAudit(value, actor), options)
	if err != nil {
		return nil, err
	}
	results := make([]any, 0, len(page.Results))
	for _, result := range page.Results {
		results = append(results, redriveResult(result))
	}
	response := map[string]any{"results": results, "nextCursor": nil}
	if page.NextCursor != nil {
		response["nextCursor"] = map[string]any{
			"finishedAt": page.NextCursor.OccurredAt.UTC().Format(redriveCursorLayout),
			"jobId":      page.NextCursor.JobID,
		}
	}
	return response, nil
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
