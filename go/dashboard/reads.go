package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	workhorse "github.com/stablemates/workhorse/go"
)

func (service *backend) cron(ctx context.Context, _ any, _ string) (any, error) {
	return service.jsonQuery(ctx, `WITH schedule_rows AS (
  SELECT d.namespace,d.schedule_name,d.cron_expression,d.queue_name,d.job_type,d.priority,d.enabled,d.revision,d.updated_at,
    count(o.occurrence_at)::integer occurrence_count,max(o.fired_at) last_fired_at
  FROM workhorse.dashboard_schedule_definition_v1 d LEFT JOIN workhorse.dashboard_schedule_occurrence_v1 o
    ON o.namespace=d.namespace AND o.schedule_name=d.schedule_name
  GROUP BY d.namespace,d.schedule_name,d.cron_expression,d.queue_name,d.job_type,d.priority,d.enabled,d.revision,d.updated_at
), schedule_page AS (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'kind','user','identity',jsonb_build_object('kind','user','namespace',d.namespace,'name',d.schedule_name),
    'namespace',d.namespace,'name',d.schedule_name,'cron',d.cron_expression,'queue',d.queue_name,
    'type',d.job_type,'priority',d.priority,'enabled',d.enabled,'active',d.enabled,
    'revision',d.revision::text,'updatedAt',d.updated_at,'occurrenceCount',d.occurrence_count,
    'lastFiredAt',d.last_fired_at) ORDER BY d.namespace,d.schedule_name),'[]'::jsonb) AS value FROM schedule_rows d),
policy AS (SELECT * FROM workhorse.dashboard_maintenance_policy_v1 WHERE singleton),
tasks AS (SELECT COALESCE(jsonb_agg(jsonb_build_object('task',s.task_name,'lastStartedAt',s.last_started_at,
  'lastCompletedAt',s.last_completed_at,'due',CASE s.task_name
    WHEN 'history_partitions' THEN s.last_completed_at IS NULL OR s.last_completed_at<=clock_timestamp()-make_interval(secs=>p.partition_preparation_interval_ms/1000.0)
    WHEN 'terminal_storage' THEN s.last_completed_at IS NULL OR s.last_completed_at<=clock_timestamp()-make_interval(secs=>p.terminal_cleanup_interval_ms/1000.0)
    WHEN 'history_retention' THEN (clock_timestamp() AT TIME ZONE p.timezone)::time>=p.history_retention_local_time AND (s.last_completed_local_date IS NULL OR s.last_completed_local_date<(clock_timestamp() AT TIME ZONE p.timezone)::date)
    ELSE false END,'incomplete',s.last_started_at IS NOT NULL AND (s.last_completed_at IS NULL OR s.last_started_at>s.last_completed_at)) ORDER BY s.task_name),'[]'::jsonb) AS value
  FROM workhorse.dashboard_maintenance_state_v1 s CROSS JOIN policy p
  WHERE s.task_name IN ('history_partitions','history_retention','terminal_storage'))
SELECT jsonb_build_object('capturedAt',clock_timestamp(),'schedules',(SELECT value FROM schedule_page),
  'maintenance',jsonb_build_object('cadences',$1::jsonb,
  'policy',jsonb_build_object('timezone',p.timezone,'partitionPreparationIntervalMs',p.partition_preparation_interval_ms,
  'terminalCleanupIntervalMs',p.terminal_cleanup_interval_ms,'historyRetentionLocalTime',left(p.history_retention_local_time::text,5),'updatedAt',p.updated_at),
  'tasks',(SELECT value FROM tasks))) AS result FROM policy p`, mustJSON(service.maintenanceLoops))
}

func (service *backend) workers(ctx context.Context, _ any, _ string) (any, error) {
	return service.jsonQuery(ctx, `WITH declared(id) AS (SELECT unnest($1::text[])), fleet(id) AS (
 SELECT worker_id FROM workhorse.dashboard_worker_registry_v1 UNION SELECT id FROM declared), active AS (
 SELECT worker_id AS id,count(*)::integer AS active_jobs,max(acquired_at) AS last_seen_at
 FROM workhorse.dashboard_job_runtime_v1 WHERE state='active' AND worker_id IN(SELECT id FROM fleet) GROUP BY worker_id), history AS (
 SELECT worker_id AS id,count(*)::integer AS completed_attempts,count(*) FILTER(WHERE outcome='failed')::integer AS failed_attempts,
 avg(extract(epoch FROM finished_at-claimed_at)*1000)::double precision AS average_execution_ms,max(finished_at) AS last_seen_at
 FROM workhorse.dashboard_attempt_history_v1 WHERE occurred_at>=clock_timestamp()-interval '1 hour' AND finished_at>=clock_timestamp()-interval '1 hour' AND worker_id IN(SELECT id FROM fleet) GROUP BY worker_id), rows AS (
 SELECT f.id,r.worker_id IS NOT NULL AS registered,r.hostname,r.pid,r.queue_names,r.concurrency,r.active_slots,r.draining,r.paused,r.started_at,r.last_heartbeat_at,
 COALESCE(a.active_jobs,0)::integer AS active_jobs,COALESCE(h.completed_attempts,0)::integer AS completed_attempts,COALESCE(h.failed_attempts,0)::integer AS failed_attempts,h.average_execution_ms,
 GREATEST(a.last_seen_at,h.last_seen_at,r.last_heartbeat_at) AS last_seen_at FROM fleet f LEFT JOIN workhorse.dashboard_worker_registry_v1 r ON r.worker_id=f.id LEFT JOIN active a ON a.id=f.id LEFT JOIN history h ON h.id=f.id ORDER BY f.id)
SELECT jsonb_build_object('capturedAt',clock_timestamp(),'canManageWorkers',$2::boolean,'workers',COALESCE(jsonb_agg(jsonb_build_object(
 'id',id,'queues',COALESCE(queue_names,'{}'),'hostname',hostname,'pid',pid,'activeJobs',active_jobs,'concurrency',concurrency,'activeSlots',active_slots,
 'draining',COALESCE(draining,false),'completedAttempts',completed_attempts,'failedAttempts',failed_attempts,'averageExecutionMs',average_execution_ms,
 'lastSeenAt',last_seen_at,'startedAt',started_at,'registered',registered,'lastHeartbeatAt',last_heartbeat_at,'paused',COALESCE(paused,false)) ORDER BY id),'[]'::jsonb)) AS result FROM rows`, service.configuredWorkers, !service.readOnly)
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
	health, err := service.admin.Health(ctx)
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

func eventsWindow(value any) (string, int) {
	document, _ := value.(map[string]any)
	window, _ := document["window"].(string)
	if window == "" {
		window = "1h"
	}
	seconds := map[string]int{"15m": 900, "1h": 3600, "6h": 21600, "24h": 86400}[window]
	return window, seconds
}

func (service *backend) events(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	window, seconds := eventsWindow(input)
	page := numberDefault(value["page"], 1)
	pageSize := numberDefault(value["pageSize"], 50)
	kind, _ := value["kind"].(string)
	if kind == "" {
		kind = "all"
	}
	types := interfaceSlice(value["types"])
	return service.jsonQuery(ctx, `WITH feed AS (
 SELECT 'event'::text kind,e.event_id record_id,e.job_id,j.queue_name,j.job_type,e.occurred_at,e.attempt,e.event_type type,e.details,NULL::text worker_id,NULL::bigint fence_token,NULL::numeric duration_ms,NULL::jsonb error,1 kind_rank FROM workhorse.dashboard_job_event_v1 e LEFT JOIN workhorse.dashboard_job_v1 j ON j.id=e.job_id WHERE $1<>'attempt'
 UNION ALL SELECT 'attempt',h.attempt_id,h.job_id,j.queue_name,j.job_type,h.occurred_at,h.attempt,h.outcome,NULL::jsonb,h.worker_id,h.fence_token,round(extract(epoch FROM h.finished_at-h.started_at)*1000),h.error,0 FROM workhorse.dashboard_attempt_history_v1 h LEFT JOIN workhorse.dashboard_job_v1 j ON j.id=h.job_id WHERE $1<>'event'), filtered AS (
 SELECT * FROM feed WHERE occurred_at>=clock_timestamp()-make_interval(secs=>$2) AND ($3::uuid IS NULL OR job_id=$3) AND (cardinality($4::text[])=0 OR type=ANY($4)) AND ($5::text IS NULL OR queue_name=$5) AND ($6::text IS NULL OR job_type=$6)), page AS (SELECT * FROM filtered ORDER BY occurred_at DESC,kind_rank DESC,record_id DESC LIMIT $7 OFFSET $8), retention AS (SELECT * FROM workhorse.dashboard_retention_policy_v1 WHERE singleton)
SELECT jsonb_build_object('capturedAt',clock_timestamp(),'window',$9::text,'windowSeconds',$2::integer,'page',$10::integer,'pageSize',$7::integer,'total',(SELECT count(*) FROM filtered),
 'retention',jsonb_build_object('jobEventDays',r.job_event_retention_days,'attemptHistoryDays',r.attempt_history_retention_days),
 'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',kind||':'||record_id::text,'kind',kind,'recordId',record_id::text,'jobId',job_id::text,'queue',queue_name,'jobType',job_type,'occurredAt',occurred_at,'attempt',attempt,'type',type,'details',details,'workerId',worker_id,'fenceToken',fence_token::text,'durationMs',duration_ms,'errorMessage',error->>'message') ORDER BY occurred_at DESC,kind_rank DESC,record_id DESC) FROM page),'[]'::jsonb)) AS result FROM retention r`, kind, seconds, value["jobId"], types, value["queue"], value["jobType"], pageSize, (page-1)*pageSize, window, page)
}

func (service *backend) eventDetail(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	id := fmt.Sprint(value["id"])
	split := strings.IndexByte(id, ':')
	if split < 0 {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Event not found"}
	}
	kind, record := id[:split], id[split+1:]
	var query string
	if kind == "event" {
		query = `SELECT jsonb_build_object('id','event:'||e.event_id::text,'kind','event','recordId',e.event_id::text,'jobId',e.job_id::text,'queue',j.queue_name,'jobType',j.job_type,'occurredAt',e.occurred_at,'attempt',e.attempt,'type',e.event_type,'details',e.details,'workerId',NULL,'fenceToken',NULL,'startedAt',NULL,'claimedAt',NULL,'finishedAt',NULL,'durationMs',NULL,'error',NULL,'errorMessage',NULL) result FROM workhorse.dashboard_job_event_v1 e LEFT JOIN workhorse.dashboard_job_v1 j ON j.id=e.job_id WHERE e.event_id=$1::bigint`
	} else if kind == "attempt" {
		query = `SELECT jsonb_build_object('id','attempt:'||h.attempt_id::text,'kind','attempt','recordId',h.attempt_id::text,'jobId',h.job_id::text,'queue',j.queue_name,'jobType',j.job_type,'occurredAt',h.occurred_at,'attempt',h.attempt,'type',h.outcome,'details',NULL,'workerId',h.worker_id,'fenceToken',h.fence_token::text,'startedAt',h.started_at,'claimedAt',h.claimed_at,'finishedAt',h.finished_at,'durationMs',round(extract(epoch FROM h.finished_at-h.started_at)*1000),'error',h.error,'errorMessage',h.error->>'message') result FROM workhorse.dashboard_attempt_history_v1 h LEFT JOIN workhorse.dashboard_job_v1 j ON j.id=h.job_id WHERE h.attempt_id=$1::bigint`
	} else {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Event not found"}
	}
	rows, err := service.executor.Query(ctx, query, record)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Event not found"}
	}
	return decodeJSONCell(rows[0]["result"])
}

func numberDefault(value any, fallback int) int {
	if value == nil {
		return fallback
	}
	var result int
	fmt.Sscan(fmt.Sprint(value), &result)
	return result
}
func interfaceSlice(value any) []any {
	if result, ok := value.([]any); ok {
		return result
	}
	return []any{}
}

func stringDefault(value any, fallback string) string {
	if result, ok := value.(string); ok && result != "" {
		return result
	}
	return fallback
}

func searchPattern(value any) any {
	if value == nil || fmt.Sprint(value) == "" {
		return nil
	}
	text := strings.NewReplacer("!", "!!", "%", "!%", "_", "!_", "*", "%").Replace(fmt.Sprint(value))
	return "%" + text + "%"
}

func (service *backend) tasks(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	filter := stringDefault(value["filter"], "all")
	sort := stringDefault(value["sort"], "updated")
	page, pageSize := numberDefault(value["page"], 1), numberDefault(value["pageSize"], 50)
	filters := map[string]string{"all": "true", "blocked": "state='blocked'", "waiting": "external_wait", "scheduled": "state='scheduled'", "retried": "attempt>1", "queued": "state='ready'", "running": "state='active'", "completed": "state='succeeded'", "discarded": "state='failed'", "canceled": "state='canceled'"}
	order := "updated_at DESC,id DESC"
	if sort == "priority" {
		order = "priority DESC,updated_at DESC,id DESC"
	}
	statement := `WITH tasks AS (SELECT j.id,j.queue_name AS queue,j.job_type AS type,j.priority,COALESCE(r.state,o.state) AS state,
 EXISTS(SELECT 1 FROM workhorse.dashboard_signal_wait_v1 s WHERE s.job_id=j.id UNION ALL SELECT 1 FROM workhorse.dashboard_human_wait_v1 h WHERE h.job_id=j.id) AS external_wait,
 CASE WHEN r.state='blocked' THEN 'prerequisite_pending' END blocked_reason,ARRAY(SELECT d.prerequisite_job_id::text FROM workhorse.dashboard_job_dependency_v1 d WHERE d.dependent_job_id=j.id AND d.released_at IS NULL ORDER BY d.prerequisite_job_id) prerequisite_job_ids,
 COALESCE(r.current_attempt,o.current_attempt) attempt,j.max_attempts,j.retry_policy,j.deadline_at,j.execution_timeout_ms,j.payload,j.tags,COALESCE(r.run_at,o.run_at) run_at,r.worker_id current_worker_id,
 COALESCE(r.worker_id,w.worker_id,a.worker_id) worker_id,o.finished_at,COALESCE(o.error,r.error) error,j.created_at,COALESCE(r.updated_at,o.updated_at,j.created_at) updated_at,r.wait_name,r.cancel_requested_at,r.cancel_requested_by,r.cancel_reason,
 w.wake_at,w.mode wait_mode,s.deadline_at signal_wait_deadline_at,h.token_name human_wait_name,h.context human_wait_context,h.deadline_at human_wait_deadline_at,e.details enqueued_details
 FROM workhorse.dashboard_job_v1 j LEFT JOIN workhorse.dashboard_job_runtime_v1 r ON r.job_id=j.id LEFT JOIN workhorse.dashboard_job_outcome_v1 o ON o.job_id=j.id
 LEFT JOIN workhorse.dashboard_job_wait_v1 w ON w.job_id=j.id AND w.wait_name=r.wait_name LEFT JOIN workhorse.dashboard_signal_wait_v1 s ON s.job_id=j.id AND s.signal_name=r.wait_name LEFT JOIN workhorse.dashboard_human_wait_v1 h ON h.job_id=j.id AND h.token_name=r.wait_name
 LEFT JOIN LATERAL(SELECT details FROM workhorse.dashboard_job_event_v1 x WHERE x.job_id=j.id AND event_type='enqueued' ORDER BY occurred_at,event_id LIMIT 1)e ON true LEFT JOIN LATERAL(SELECT worker_id FROM workhorse.dashboard_attempt_history_v1 x WHERE x.job_id=j.id ORDER BY attempt DESC LIMIT 1)a ON true),
 filtered AS (SELECT * FROM tasks WHERE ` + filters[filter] + ` AND ($1::text IS NULL OR queue=$1) AND ($2::text IS NULL OR worker_id=$2) AND ($3::text IS NULL OR type=$3) AND ($4::integer IS NULL OR priority=$4) AND (cardinality($5::text[])=0 OR tags&&$5) AND ($6::text IS NULL OR type ILIKE $6 ESCAPE '!' OR queue ILIKE $6 ESCAPE '!' OR id::text ILIKE $6 ESCAPE '!')),
 page AS (SELECT * FROM filtered ORDER BY ` + order + ` LIMIT $7 OFFSET $8), counts AS (SELECT count(*)::integer all,count(*) FILTER(WHERE state='blocked')::integer blocked,count(*) FILTER(WHERE external_wait)::integer waiting,count(*) FILTER(WHERE state='scheduled')::integer scheduled,count(*) FILTER(WHERE attempt>1)::integer retried,count(*) FILTER(WHERE state='ready')::integer queued,count(*) FILTER(WHERE state='active')::integer running,count(*) FILTER(WHERE state='succeeded')::integer completed,count(*) FILTER(WHERE state='failed')::integer discarded,count(*) FILTER(WHERE state='canceled')::integer canceled FROM tasks)
 SELECT jsonb_build_object('capturedAt',clock_timestamp(),'canCompleteHumanWait',true,'filter',$9::text,'queue',$1::text,'worker',$2::text,'jobType',$3::text,'priority',$4::integer,'sort',$10::text,'tags',$5::text[],'search',$11::text,'page',$12::integer,'pageSize',$7::integer,'total',(SELECT count(*) FROM filtered),
 'counts',(SELECT to_jsonb(counts) FROM counts),'jobs',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id::text,'queue',queue,'type',type,'priority',priority,'state',state,'blockedReason',blocked_reason,'prerequisiteJobIds',prerequisite_job_ids,'attempt',attempt,'maxAttempts',max_attempts,'retryPolicy',retry_policy,'deadlineAt',deadline_at,'executionTimeoutMs',execution_timeout_ms,'payload',payload,'tags',tags,'keyed',COALESCE(jsonb_typeof(enqueued_details->'idempotency')='object',false),'cancellation',CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE jsonb_build_object('requestedAt',cancel_requested_at,'requestedBy',NULLIF(cancel_requested_by,''),'reason',NULLIF(cancel_reason,'')) END,'runAt',run_at,'workerId',current_worker_id,'lastWorkerId',worker_id,'finishedAt',finished_at,'errorMessage',error->>'message','createdAt',created_at,'updatedAt',updated_at,'durability',NULL,'waitName',wait_name,'wakeAt',wake_at,'wait',CASE WHEN wait_name IS NOT NULL AND wake_at IS NOT NULL AND wait_mode IS NOT NULL THEN jsonb_build_object('name',wait_name,'wakeAt',wake_at,'mode',wait_mode) END,'signalWait',CASE WHEN wait_name IS NOT NULL AND signal_wait_deadline_at IS NOT NULL THEN jsonb_build_object('name',wait_name,'deadlineAt',signal_wait_deadline_at) END,'humanWait',CASE WHEN human_wait_name IS NOT NULL AND human_wait_deadline_at IS NOT NULL THEN jsonb_build_object('name',human_wait_name,'context',human_wait_context,'deadlineAt',human_wait_deadline_at) END) ORDER BY ` + order + `) FROM page),'[]'::jsonb)) result`
	result, err := service.jsonQuery(ctx, statement, value["queue"], value["worker"], value["jobType"], value["priority"], interfaceSlice(value["tags"]), searchPattern(value["search"]), pageSize, (page-1)*pageSize, filter, sort, value["search"], page)
	if page, ok := result.(map[string]any); ok {
		page["canCompleteHumanWait"] = !service.readOnly
	}
	return result, err
}

func (service *backend) activity(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	period, groupBy, filter := stringDefault(value["period"], "1h"), stringDefault(value["groupBy"], "task"), stringDefault(value["filter"], "all")
	windows := map[string][2]int{"15m": {900, 30}, "1h": {3600, 120}, "6h": {21600, 600}, "24h": {86400, 3600}, "7d": {604800, 21600}}
	span := windows[period]
	groups := map[string]string{"queue": "j.queue_name", "task": "j.job_type", "status": "COALESCE(r.state,o.state)", "worker": "COALESCE(r.worker_id,a.worker_id,'unassigned')"}
	filters := map[string]string{"all": "true", "blocked": "state='blocked'", "waiting": "external_wait", "scheduled": "state='scheduled'", "retried": "attempt>1", "queued": "state='ready'", "running": "state='active'", "completed": "state='succeeded'", "discarded": "state='failed'", "canceled": "state='canceled'"}
	statement := `WITH candidate AS(SELECT job_id FROM workhorse.dashboard_job_runtime_v1 WHERE updated_at>=clock_timestamp()-make_interval(secs=>$1) UNION SELECT job_id FROM workhorse.dashboard_job_outcome_v1 WHERE updated_at>=clock_timestamp()-make_interval(secs=>$1)), tasks AS(SELECT ` + groups[groupBy] + ` group_key,COALESCE(r.state,o.state) state,EXISTS(SELECT 1 FROM workhorse.dashboard_signal_wait_v1 s WHERE s.job_id=c.job_id UNION ALL SELECT 1 FROM workhorse.dashboard_human_wait_v1 h WHERE h.job_id=c.job_id) external_wait,COALESCE(r.current_attempt,o.current_attempt) attempt,COALESCE(r.updated_at,o.updated_at) updated_at,j.tags,j.queue_name queue,COALESCE(r.worker_id,a.worker_id,'unassigned') worker_id FROM candidate c JOIN workhorse.dashboard_job_v1 j ON j.id=c.job_id LEFT JOIN workhorse.dashboard_job_runtime_v1 r ON r.job_id=c.job_id LEFT JOIN workhorse.dashboard_job_outcome_v1 o ON o.job_id=c.job_id LEFT JOIN LATERAL(SELECT worker_id FROM workhorse.dashboard_attempt_history_v1 x WHERE x.job_id=c.job_id ORDER BY attempt DESC LIMIT 1)a ON true), buckets AS(SELECT generate_series(date_bin(make_interval(secs=>$2),clock_timestamp()-make_interval(secs=>$1),timestamp with time zone '2000-01-01')+make_interval(secs=>$2),date_bin(make_interval(secs=>$2),clock_timestamp(),timestamp with time zone '2000-01-01'),make_interval(secs=>$2)) bucket_start), rows AS(SELECT b.bucket_start,t.group_key,count(t.updated_at)::integer count FROM buckets b LEFT JOIN tasks t ON t.updated_at>=b.bucket_start AND t.updated_at<b.bucket_start+make_interval(secs=>$2) AND ` + filters[filter] + ` AND(cardinality($3::text[])=0 OR t.tags&&$3) AND($4::text IS NULL OR t.queue=$4) AND($5::text IS NULL OR t.worker_id=$5) GROUP BY b.bucket_start,t.group_key ORDER BY b.bucket_start), groups AS(SELECT DISTINCT group_key FROM rows WHERE group_key IS NOT NULL), series AS(SELECT g.group_key,jsonb_agg(jsonb_build_object('bucketStart',r.bucket_start,'count',r.count) ORDER BY r.bucket_start) buckets,sum(r.count)::integer total FROM groups g JOIN rows r ON r.group_key=g.group_key GROUP BY g.group_key)
SELECT jsonb_build_object('capturedAt',clock_timestamp(),'filter',$8::text,'period',$6::text,'groupBy',$7::text,'bucketSeconds',$2::integer,'groups',COALESCE((SELECT jsonb_agg(group_key ORDER BY group_key)FROM groups),'[]'::jsonb),'buckets',COALESCE((SELECT jsonb_agg(jsonb_build_object('bucketStart',bucket_start,'counts',counts)ORDER BY bucket_start)FROM(SELECT bucket_start,COALESCE(jsonb_object_agg(group_key,count)FILTER(WHERE group_key IS NOT NULL),'{}'::jsonb)counts FROM rows GROUP BY bucket_start)x),'[]'::jsonb)) result`
	return service.jsonQuery(ctx, statement, span[0], span[1], interfaceSlice(value["tags"]), value["queue"], value["worker"], period, groupBy, filter)
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
