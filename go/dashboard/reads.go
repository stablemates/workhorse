package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	workhorse "github.com/stablemates/workhorse/go"
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
	waits, err := service.admin.ListHumanWaits(ctx, workhorse.ExternalWaitQuery{Limit: 50})
	if err != nil {
		return nil, err
	}
	signals, err := service.admin.ListSignalWaits(ctx, workhorse.ExternalWaitQuery{Limit: 50})
	if err != nil {
		return nil, err
	}
	health, err := service.health(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"capturedAt": time.Now().UTC(), "canComplete": !service.readOnly, "canSignal": !service.readOnly,
		"diagnostics": map[string]any{
			"pendingSignals": integer(health["pending_signal_waits"]), "pendingHumanDecisions": integer(health["pending_human_waits"]),
			"overdue": integer(health["overdue_external_waits"]), "oldestPendingAgeMs": optionalDecimal(health["oldest_external_wait_age_ms"]),
			"rejectedDeliveries": integer(health["rejected_wait_deliveries"]), "capped": health["external_wait_counts_capped"],
		},
		"waits": dashboardExternalWaits(waits.Items, true), "signalWaits": dashboardExternalWaits(signals.Items, false),
	}, nil
}

func optionalDecimal(value any) any {
	if value == nil {
		return nil
	}
	return decimal(value)
}

func dashboardExternalWaits(items []workhorse.ExternalWait, includeContext bool) []map[string]any {
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		row := map[string]any{"jobId": item.JobID, "queue": item.Queue, "jobType": item.JobType, "name": item.Name, "attempt": item.Attempt, "createdAt": item.CreatedAt, "deadlineAt": item.DeadlineAt}
		if includeContext {
			row["context"] = item.Context
		}
		result = append(result, row)
	}
	return result
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
	statement := `WITH job AS(SELECT j.id,j.queue_name queue,j.job_type type,j.priority,j.payload,j.max_attempts,j.retry_policy,j.deadline_at,j.execution_timeout_ms,j.concurrency_key,j.created_at,r.state runtime_state,r.current_attempt runtime_attempt,r.run_at,r.ready_at,r.worker_id,r.fence_token::text,r.acquired_at,r.heartbeat_at,r.expires_at,r.wait_name,r.attempt_started_at,r.attempt_timeout_at,r.cancel_requested_at,r.cancel_requested_by,r.cancel_reason,r.error runtime_error,o.state outcome_state,o.current_attempt outcome_attempt,o.finished_at,workhorse.dashboard_job_result_v1(j.id) result,o.error outcome_error,p.progress_value,p.revision::text progress_revision,p.attempt progress_attempt,p.fence_token::text progress_fence_token,p.worker_id progress_worker_id,p.created_at progress_created_at,p.updated_at progress_updated_at,s.deadline_at signal_wait_deadline_at FROM workhorse.dashboard_job_v1 j LEFT JOIN workhorse.dashboard_job_runtime_v1 r ON r.job_id=j.id LEFT JOIN workhorse.dashboard_job_outcome_v1 o ON o.job_id=j.id LEFT JOIN workhorse.dashboard_job_progress_v1 p ON p.job_id=j.id LEFT JOIN workhorse.dashboard_signal_wait_v1 s ON s.job_id=j.id AND s.signal_name=r.wait_name WHERE j.id=$1::uuid), deps AS(SELECT * FROM workhorse.dashboard_job_dependency_v1 WHERE dependent_job_id=$1::uuid OR prerequisite_job_id=$1::uuid ORDER BY dependent_job_id,prerequisite_job_id LIMIT 101), own AS(SELECT * FROM deps WHERE dependent_job_id=$1::uuid), children AS(SELECT e.*,c.job_type child_type,o.state outcome_state,o.error outcome_error FROM workhorse.dashboard_job_child_v1 e JOIN workhorse.dashboard_job_v1 c ON c.id=e.child_job_id LEFT JOIN workhorse.dashboard_job_outcome_v1 o ON o.job_id=e.child_job_id WHERE e.parent_job_id=$1::uuid OR e.child_job_id=$1::uuid ORDER BY e.created_at,e.parent_job_id,e.child_job_id LIMIT 102), redrives AS(SELECT * FROM workhorse.redrive_lineage_v1($1::uuid,101)), attempts AS(SELECT * FROM workhorse.dashboard_attempt_history_v1 WHERE job_id=$1::uuid ORDER BY attempt,attempt_id), checkpoints AS(SELECT * FROM workhorse.dashboard_job_checkpoint_v1 WHERE job_id=$1::uuid ORDER BY created_at,checkpoint_name), waits AS(SELECT * FROM workhorse.dashboard_job_wait_v1 WHERE job_id=$1::uuid ORDER BY created_at,wait_name), events AS(SELECT * FROM workhorse.dashboard_job_event_v1 WHERE job_id=$1::uuid ORDER BY occurred_at,event_id)
SELECT jsonb_build_object('identity',jsonb_build_object('id',j.id::text,'queue',j.queue,'type',j.type,'priority',j.priority,'state',COALESCE(j.outcome_state,j.runtime_state,'unknown'),'createdAt',j.created_at,'retryPolicy',j.retry_policy,'maxAttempts',j.max_attempts,'deadlineAt',j.deadline_at,'executionTimeoutMs',j.execution_timeout_ms,'concurrencyKey',j.concurrency_key,'prerequisiteJobId',CASE WHEN(SELECT count(*) FROM own)=1 THEN(SELECT prerequisite_job_id::text FROM own LIMIT 1)END,'prerequisiteJobIds',COALESCE((SELECT jsonb_agg(prerequisite_job_id::text ORDER BY prerequisite_job_id)FROM own),'[]'::jsonb),'dependencyPolicy',CASE WHEN EXISTS(SELECT 1 FROM own)THEN(SELECT jsonb_build_object('onSuccess',on_success,'onFailure',on_failure,'onCancellation',on_cancellation)FROM own LIMIT 1)END,'dependencyReleasedAt',CASE WHEN(SELECT bool_and(released_at IS NOT NULL)FROM own)THEN(SELECT max(released_at)FROM own)END,'blockedReason',CASE WHEN j.runtime_state='blocked' AND EXISTS(SELECT 1 FROM own)THEN'prerequisite_pending'END),
'dependencyLineage',jsonb_build_object('records',COALESCE((SELECT jsonb_agg(jsonb_build_object('dependentJobId',dependent_job_id::text,'prerequisiteJobId',prerequisite_job_id::text,'onSuccess',on_success,'onFailure',on_failure,'onCancellation',on_cancellation,'createdAt',created_at,'releasedAt',released_at,'resolution',resolution)ORDER BY dependent_job_id,prerequisite_job_id)FROM(SELECT * FROM deps LIMIT 100)x),'[]'::jsonb),'truncated',(SELECT count(*)FROM deps)>100),
'childLineage',jsonb_build_object('records',COALESCE((SELECT jsonb_agg(jsonb_build_object('parentJobId',parent_job_id::text,'childJobId',child_job_id::text,'name',child_name,'type',child_type,'createdAt',created_at,'joinedAt',joined_at,'outcomeState',outcome_state,'error',outcome_error)ORDER BY created_at,parent_job_id,child_job_id)FROM(SELECT * FROM children LIMIT 101)x),'[]'::jsonb),'truncated',(SELECT count(*)FROM children)>101),
'redriveLineage',jsonb_build_object('records',COALESCE((SELECT jsonb_agg(jsonb_build_object('sourceJobId',source_job_id::text,'targetJobId',target_job_id::text,'requestedBy',requested_by,'reason',reason,'requestIdPreview',request_id_preview,'requestIdDigest',request_id_digest,'requestIdLength',request_id_length,'sourceState',source_state,'targetInitialState',target_initial_state,'requestedAt',requested_at)ORDER BY requested_at)FROM(SELECT * FROM redrives LIMIT 100)x),'[]'::jsonb),'truncated',(SELECT count(*)FROM redrives)>100),
'concurrencyPolicy',NULL,'signalWait',CASE WHEN j.wait_name IS NOT NULL AND j.signal_wait_deadline_at IS NOT NULL THEN jsonb_build_object('name',j.wait_name,'deadlineAt',j.signal_wait_deadline_at)END,'canSignal',true,'payload',j.payload,'progress',CASE WHEN j.progress_revision IS NOT NULL THEN jsonb_build_object('value',j.progress_value,'revision',j.progress_revision,'attempt',j.progress_attempt,'fenceToken',j.progress_fence_token,'workerId',j.progress_worker_id,'createdAt',j.progress_created_at,'updatedAt',j.progress_updated_at)END,'durability',NULL,
'current',jsonb_build_object('runtime',CASE WHEN j.runtime_state IS NOT NULL THEN jsonb_build_object('state',j.runtime_state,'attempt',j.runtime_attempt,'runAt',j.run_at,'readyAt',j.ready_at,'workerId',j.worker_id,'fenceToken',j.fence_token,'acquiredAt',j.acquired_at,'heartbeatAt',j.heartbeat_at,'expiresAt',j.expires_at,'waitName',j.wait_name,'attemptStartedAt',j.attempt_started_at,'attemptTimeoutAt',j.attempt_timeout_at,'cancellation',CASE WHEN j.cancel_requested_at IS NOT NULL THEN jsonb_build_object('requestedAt',j.cancel_requested_at,'requestedBy',NULLIF(j.cancel_requested_by,''),'reason',NULLIF(j.cancel_reason,''))END,'error',j.runtime_error)END,'outcome',CASE WHEN j.outcome_state IS NOT NULL THEN jsonb_build_object('state',j.outcome_state,'attempt',j.outcome_attempt,'finishedAt',j.finished_at,'result',j.result,'error',j.outcome_error)END,'result',j.result,'error',COALESCE(j.outcome_error,j.runtime_error)),
'batchExecutions','[]'::jsonb,'attempts',COALESCE((SELECT jsonb_agg(jsonb_build_object('attempt',attempt,'workerId',worker_id,'outcome',outcome,'startedAt',started_at,'claimedAt',claimed_at,'finishedAt',finished_at,'durationMs',extract(epoch FROM finished_at-claimed_at)*1000,'executionMs',extract(epoch FROM finished_at-claimed_at)*1000,'elapsedMs',extract(epoch FROM finished_at-started_at)*1000,'error',error)ORDER BY attempt,attempt_id)FROM attempts),'[]'::jsonb),'checkpoints',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',checkpoint_name,'value',checkpoint_value,'attempt',attempt,'fenceToken',fence_token::text,'workerId',worker_id,'createdAt',created_at)ORDER BY created_at,checkpoint_name)FROM checkpoints),'[]'::jsonb),'waits',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',wait_name,'mode',mode,'durationMs',duration_ms,'requestedWakeAt',requested_wake_at,'wakeAt',wake_at,'attempt',attempt,'fenceToken',fence_token::text,'workerId',worker_id,'createdAt',created_at)ORDER BY created_at,wait_name)FROM waits),'[]'::jsonb),'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',event_id::text,'attempt',attempt,'type',event_type,'details',details,'occurredAt',occurred_at)ORDER BY occurred_at,event_id)FROM events),'[]'::jsonb)) result FROM job j`
	rows, err := service.executor.Query(ctx, statement, value["id"])
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Task not found"}
	}
	decoded, err := decodeJSONCell(rows[0]["result"])
	if err != nil {
		return nil, err
	}
	page, ok := decoded.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("job detail returned %T", rows[0]["result"])
	}
	identity := page["identity"].(map[string]any)
	queueName := fmt.Sprint(identity["queue"])
	policyRows, err := service.executor.Query(ctx, `SELECT namespace,max_active,max_active_per_key FROM workhorse.dashboard_concurrency_policy_v1 WHERE queue_name=$1`, queueName)
	if err != nil {
		return nil, err
	}
	if len(policyRows) > 0 {
		var measured map[string]any
		current := page["current"].(map[string]any)
		if current["runtime"] != nil {
			health, healthErr := service.health(ctx)
			if healthErr != nil {
				return nil, healthErr
			}
			policies, _, _, _ := admissionPolicies(health)
			measured, _ = policies[queueName].(map[string]any)
		}
		policy := policyRows[0]
		page["concurrencyPolicy"] = map[string]any{
			"namespace": policy["namespace"], "maxActive": integer(policy["max_active"]),
			"utilizationKnown": measured != nil, "active": measuredInteger(measured, "active"),
			"available": measuredInteger(measured, "available"), "blockedReady": measuredInteger(measured, "blockedReady"),
			"maxActivePerKey": nullableInteger(policy["max_active_per_key"]), "saturatedKeys": measuredInteger(measured, "saturatedKeys"),
			"highestKeyActive": measuredInteger(measured, "highestKeyActive"),
		}
	}
	batchExecutions, err := service.jsonQuery(ctx, `WITH batch_rows AS(SELECT dispatch.details->>'batch_id' batch_id,dispatch.attempt selected_attempt,dispatch.occurred_at dispatched_at,EXISTS(SELECT 1 FROM workhorse.dashboard_job_event_v1 failure WHERE failure.job_id=dispatch.job_id AND failure.attempt=dispatch.attempt AND failure.event_type='batch_failed' AND failure.details->>'batch_id'=dispatch.details->>'batch_id')batch_wide_failure,member.ordinal,member.value->>'job_id' job_id,COALESCE(member_job.job_type,selected_job.job_type)job_type,(member.value->>'attempt')::integer attempt,history.outcome,history.error FROM workhorse.dashboard_job_event_v1 dispatch CROSS JOIN LATERAL jsonb_array_elements(dispatch.details->'members')WITH ORDINALITY AS member(value,ordinal)JOIN workhorse.dashboard_job_v1 selected_job ON selected_job.id=dispatch.job_id LEFT JOIN workhorse.dashboard_job_v1 member_job ON member_job.id=(member.value->>'job_id')::uuid LEFT JOIN workhorse.dashboard_attempt_history_v1 history ON history.job_id=(member.value->>'job_id')::uuid AND history.attempt=(member.value->>'attempt')::integer WHERE dispatch.job_id=$1::uuid AND dispatch.event_type='batch_dispatched' ORDER BY dispatch.occurred_at,dispatch.event_id,member.ordinal),executions AS(SELECT batch_id,selected_attempt,dispatched_at,batch_wide_failure,jsonb_agg(jsonb_build_object('id',job_id,'type',job_type,'attempt',attempt,'outcome',outcome,'error',error)ORDER BY ordinal)members FROM batch_rows GROUP BY batch_id,selected_attempt,dispatched_at,batch_wide_failure)SELECT COALESCE(jsonb_agg(jsonb_build_object('id',batch_id,'attempt',selected_attempt,'dispatchedAt',dispatched_at,'batchWideFailure',batch_wide_failure,'members',members)ORDER BY dispatched_at,batch_id),'[]'::jsonb)result FROM executions`, value["id"])
	if err != nil {
		return nil, err
	}
	page["batchExecutions"] = batchExecutions
	return page, nil
}

func measuredInteger(policy map[string]any, key string) int {
	if policy == nil {
		return 0
	}
	return integer(policy[key])
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
