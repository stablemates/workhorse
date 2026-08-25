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

func (service *backend) settings(ctx context.Context, _ any, _ string) (any, error) {
	return service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_settings_v1($1::jsonb) AS result",
		string(mustJSON(map[string]any{
			"writable": !service.readOnly, "settingsController": true,
		})),
	)
}
