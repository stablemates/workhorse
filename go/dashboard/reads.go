package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
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
	input := string(mustJSON(map[string]any{
		"canComplete": !service.readOnly,
		"canSignal":   !service.readOnly,
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

func stringDefault(value any, fallback string) string {
	if result, ok := value.(string); ok && result != "" {
		return result
	}
	return fallback
}

func (service *backend) tasks(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	defaults := map[string]any{
		"filter": "all", "queue": nil, "page": 1, "worker": nil, "jobType": nil,
		"priority": nil, "sort": "updated", "tags": []any{}, "search": nil, "pageSize": 50,
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
	value, _ := document(input)
	definition := value["definition"].(map[string]any)
	rows, err := service.executor.Query(ctx, "SELECT (policy).* FROM workhorse.get_retention_policy_v1() policy")
	if err != nil {
		return nil, err
	}
	names := []string{"jobIdentityRetentionDays", "terminalOutcomeRetentionDays", "jobEventRetentionDays", "attemptHistoryRetentionDays", "scheduleOccurrenceRetentionDays", "statisticsRetentionDays"}
	values := make([]any, len(names))
	for index, name := range names {
		values[index] = definition[name]
		if values[index] == nil {
			values[index] = rows[0][snake(name)]
		}
	}
	return service.jsonQuery(ctx, `SELECT jsonb_build_object('eligible',jsonb_build_object('terminalJobs',LEAST(terminal_jobs,10000),'jobEvents',LEAST(job_events,10000),'attemptHistory',LEAST(attempt_history,10000),'scheduleOccurrences',LEAST(schedule_occurrences,10000),'statistics',LEAST(statistics,10000)),'capped',jsonb_build_object('terminalJobs',terminal_jobs>10000,'jobEvents',job_events>10000,'attemptHistory',attempt_history>10000,'scheduleOccurrences',schedule_occurrences>10000,'statistics',statistics>10000)) result FROM(SELECT (SELECT count(*) FROM(SELECT 1 FROM workhorse.job j JOIN workhorse.job_outcome o ON o.job_id=j.id WHERE $1::integer IS NOT NULL AND $2::integer IS NOT NULL AND j.created_at<clock_timestamp()-make_interval(days=>$1) AND o.finished_at<clock_timestamp()-make_interval(days=>$2) LIMIT 10001)x)terminal_jobs,(SELECT count(*) FROM(SELECT 1 FROM workhorse.job_event WHERE $3::integer IS NOT NULL AND occurred_at<clock_timestamp()-make_interval(days=>$3) LIMIT 10001)x)job_events,(SELECT count(*) FROM(SELECT 1 FROM workhorse.attempt_history WHERE $4::integer IS NOT NULL AND occurred_at<clock_timestamp()-make_interval(days=>$4) LIMIT 10001)x)attempt_history,(SELECT count(*) FROM(SELECT 1 FROM workhorse.schedule_occurrence WHERE $5::integer IS NOT NULL AND occurrence_at<clock_timestamp()-make_interval(days=>$5) LIMIT 10001)x)schedule_occurrences,(SELECT count(*) FROM(SELECT 1 FROM workhorse.job_stat_bucket WHERE $6::integer IS NOT NULL AND bucket_start<clock_timestamp()-make_interval(days=>$6) UNION ALL SELECT 1 FROM workhorse.job_stat_bucket_hour WHERE $6::integer IS NOT NULL AND bucket_start<clock_timestamp()-make_interval(days=>$6) UNION ALL SELECT 1 FROM workhorse.job_stat_bucket_day WHERE $6::integer IS NOT NULL AND bucket_start<clock_timestamp()-make_interval(days=>$6) LIMIT 10001)x)statistics)s`, values...)
}

func (service *backend) jobDetail(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	value["canSignal"] = !service.readOnly
	result, err := service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_job_detail_v1($1::jsonb) AS result",
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

func (service *backend) health(ctx context.Context) (map[string]any, error) {
	service.healthMu.Lock()
	defer service.healthMu.Unlock()
	if service.healthValue != nil && time.Now().Before(service.healthExpiresAt) {
		return service.healthValue, nil
	}
	rows, err := service.executor.Query(ctx, "SELECT workhorse.queue_health_v1() AS snapshot")
	if err != nil {
		return nil, err
	}
	var value map[string]any
	switch encoded := rows[0]["snapshot"].(type) {
	case []byte:
		if err := json.Unmarshal(encoded, &value); err != nil {
			return nil, err
		}
	case string:
		if err := json.Unmarshal([]byte(encoded), &value); err != nil {
			return nil, err
		}
	case map[string]any:
		value = encoded
	default:
		return nil, fmt.Errorf("queue_health_v1 returned %T", encoded)
	}
	service.healthValue = value
	service.healthExpiresAt = time.Now().Add(3 * time.Second)
	return value, nil
}

func policyProjection(row map[string]any, names []string) map[string]any {
	overrides := make(map[string]bool)
	for _, name := range stringValues(row["operator_overrides"]) {
		overrides[name] = true
	}
	result, provenance := make(map[string]any), make(map[string]any)
	for _, name := range names {
		column := snake(name)
		current, application := row[column], row["application_"+column]
		if name == "historyRetentionLocalTime" {
			current = localTime(current)
			application = localTime(application)
		}
		result[name] = current
		source := "application"
		if overrides[column] {
			source = "operator"
		}
		provenance[name] = map[string]any{"source": source, "applicationDefault": application}
	}
	result["provenance"], result["updatedAt"] = provenance, timestamp(row["updated_at"])
	return result
}

func localTime(value any) string {
	if clock, ok := value.(pgtype.Time); ok {
		seconds := clock.Microseconds / 1_000_000
		return fmt.Sprintf("%02d:%02d", seconds/3600, (seconds%3600)/60)
	}
	text := fmt.Sprint(value)
	if len(text) >= 5 {
		return text[:5]
	}
	return text
}

func stringValues(value any) []string {
	switch items := value.(type) {
	case []string:
		return items
	case []any:
		result := make([]string, len(items))
		for i, item := range items {
			result[i] = fmt.Sprint(item)
		}
		return result
	case string:
		var result []string
		if err := pgtype.NewMap().Scan(pgtype.TextArrayOID, pgtype.TextFormatCode, []byte(items), &result); err == nil {
			return result
		}
	case []byte:
		var result []string
		if err := pgtype.NewMap().Scan(pgtype.TextArrayOID, pgtype.TextFormatCode, items, &result); err == nil {
			return result
		}
	default:
	}
	return nil
}

func (service *backend) settings(ctx context.Context, _ any, _ string) (any, error) {
	maintenanceRows, err := service.executor.Query(ctx, "SELECT (policy).* FROM workhorse.get_maintenance_policy_v1() policy")
	if err != nil {
		return nil, err
	}
	retentionRows, err := service.executor.Query(ctx, "SELECT (policy).* FROM workhorse.get_retention_policy_v1() policy")
	if err != nil {
		return nil, err
	}
	health, err := service.health(ctx)
	if err != nil {
		return nil, err
	}
	enqueuedRows, err := service.executor.Query(ctx, `SELECT COALESCE(sum(enqueued),0)::integer jobs FROM workhorse.stat_buckets_v1(date_bin('1 minute',clock_timestamp(),timestamp with time zone '2000-01-01')-interval '1 hour'+interval '1 minute',clock_timestamp())`)
	if err != nil {
		return nil, err
	}
	workers, err := service.executor.Query(ctx, `SELECT worker_id,queue_names,concurrency,lease_ms,heartbeat_ms,poll_ms,maintenance_interval_ms,maintenance_task_poll_ms,registry_interval_ms,last_heartbeat_at FROM workhorse.dashboard_worker_registry_v1 WHERE last_heartbeat_at>=clock_timestamp()-GREATEST(interval '30 seconds',registry_interval_ms*3*interval '1 millisecond') ORDER BY worker_id`)
	if err != nil {
		return nil, err
	}
	projectedWorkers := make([]any, 0, len(workers))
	for _, row := range workers {
		queues := stringValues(row["queue_names"])
		var queue any
		if len(queues) > 0 {
			queue = queues[0]
		}
		projectedWorkers = append(projectedWorkers, map[string]any{"id": row["worker_id"], "queue": queue, "queues": queues, "concurrency": row["concurrency"], "leaseMs": row["lease_ms"], "heartbeatMs": row["heartbeat_ms"], "pollMs": row["poll_ms"], "maintenanceIntervalMs": row["maintenance_interval_ms"], "maintenanceTaskPollMs": row["maintenance_task_poll_ms"], "registryIntervalMs": row["registry_interval_ms"], "lastSeenAt": timestamp(row["last_heartbeat_at"])})
	}
	status, _ := health["status"].(map[string]any)
	return map[string]any{"capturedAt": timestamp(time.Now()), "editable": !service.readOnly,
		"maintenance":          policyProjection(maintenanceRows[0], []string{"timezone", "partitionPreparationIntervalMs", "terminalCleanupIntervalMs", "historyRetentionLocalTime", "statisticsRollupIntervalMs", "statisticsGroupLimit", "statisticsRecomputeBuckets"}),
		"retention":            policyProjection(retentionRows[0], []string{"jobIdentityRetentionDays", "terminalOutcomeRetentionDays", "jobEventRetentionDays", "attemptHistoryRetentionDays", "scheduleOccurrenceRetentionDays", "statisticsRetentionDays", "terminalJobPruneLimit", "historyPartitionsPerPass", "defaultPartitionRowsPerPass", "occurrenceRowsPerPass", "statisticsRowsPerPass"}),
		"recommendationInputs": map[string]any{"reasons": status["reasons"], "statistics": map[string]any{"rolledUpThrough": health["rolled_up_through"], "lagMs": decimal(health["rollup_lag_ms"]), "lastRunAt": health["last_run_at"]}, "defaultHistoryRows": map[string]any{"jobEvents": integer(health["default_event_rows"]), "attemptHistory": integer(health["default_attempt_rows"])}, "defaultHistoryRowsCapped": map[string]any{"jobEvents": health["default_event_rows_capped"], "attemptHistory": health["default_attempt_rows_capped"]}, "enqueueRate": map[string]any{"jobs": enqueuedRows[0]["jobs"], "windowMs": 3600000}}, "workers": projectedWorkers}, nil
}
