package dashboard

import (
	"context"
	"fmt"
	"sort"
	"time"
)

func integer(value any) int {
	var result int
	fmt.Sscan(fmt.Sprint(value), &result)
	return result
}

func decimal(value any) float64 {
	var result float64
	fmt.Sscan(fmt.Sprint(value), &result)
	return result
}

func (service *backend) system(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	window := stringDefault(value["window"], "1h")
	seconds := map[string]int{"15m": 900, "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800}[window]
	start := "date_bin('1 minute',clock_timestamp(),timestamp with time zone '2000-01-01')-make_interval(secs=>$1)+interval '1 minute'"
	stat := "workhorse.stat_buckets_v1(" + start + ",clock_timestamp())"
	outcomes, err := service.jsonQuery(ctx, `WITH buckets AS(SELECT generate_series(`+start+`,date_bin('1 minute',clock_timestamp(),timestamp with time zone '2000-01-01'),interval '1 minute') bucket_start),rolled AS(SELECT bucket_start,sum(enqueued)::integer enqueued,sum(attempt_succeeded)::integer succeeded,sum(attempt_failed)::integer failed,sum(attempt_retry)::integer retry,sum(attempt_lease_expired)::integer lease_expired,sum(attempt_canceled)::integer canceled FROM `+stat+` GROUP BY 1),rows AS(SELECT b.bucket_start,COALESCE(r.enqueued,0)::integer enqueued,COALESCE(r.succeeded,0)::integer succeeded,COALESCE(r.failed,0)::integer failed,COALESCE(r.retry,0)::integer retry,COALESCE(r.lease_expired,0)::integer lease_expired,COALESCE(r.canceled,0)::integer canceled FROM buckets b LEFT JOIN rolled r USING(bucket_start)ORDER BY b.bucket_start)SELECT COALESCE(jsonb_agg(jsonb_build_object('bucketStart',bucket_start,'enqueued',enqueued,'succeeded',succeeded,'failed',failed,'retry',retry,'leaseExpired',lease_expired,'canceled',canceled)ORDER BY bucket_start),'[]'::jsonb) result FROM rows`, seconds)
	if err != nil {
		return nil, err
	}
	attempts := "(attempt_succeeded+attempt_failed+attempt_retry+attempt_lease_expired+attempt_canceled+attempt_other)"
	errors := "(attempt_failed+attempt_retry+attempt_lease_expired+attempt_other)"
	completed := "(attempt_succeeded+attempt_failed+attempt_canceled)"
	summaryRows, err := service.executor.Query(ctx, `WITH current_window AS(SELECT COALESCE(sum(enqueued),0)::integer enqueued,COALESCE(sum(`+completed+`),0)::integer completed,COALESCE(sum(`+attempts+`),0)::integer attempts,COALESCE(sum(`+errors+`),0)::integer errors,COALESCE(sum(attempt_lease_expired),0)::integer recovered FROM `+stat+`),previous_window AS(SELECT COALESCE(sum(`+attempts+`),0)::integer attempts,COALESCE(sum(`+errors+`),0)::integer errors FROM workhorse.stat_buckets_v1(date_bin('1 minute',clock_timestamp(),timestamp with time zone '2000-01-01')-make_interval(secs=>$1*2)+interval '1 minute',`+start+`))SELECT c.*,p.attempts previous_attempts,p.errors previous_errors FROM current_window c CROSS JOIN previous_window p`, seconds)
	if err != nil {
		return nil, err
	}
	summary := summaryRows[0]
	waitRows, err := service.executor.Query(ctx, `WITH merged AS(SELECT workhorse.stat_sketch_merge_v1(array_agg(wait_sketch)) sketch FROM `+stat+`)SELECT workhorse.stat_sketch_percentile_v1(sketch,.50) p50,workhorse.stat_sketch_percentile_v1(sketch,.95)p95,workhorse.stat_sketch_percentile_v1(sketch,.99)p99 FROM merged`, seconds)
	if err != nil {
		return nil, err
	}
	wait := waitRows[0]
	runtimeRows, err := service.executor.Query(ctx, `SELECT count(*)FILTER(WHERE state='ready')::integer ready,(extract(epoch FROM clock_timestamp()-min(ready_at)FILTER(WHERE state='ready'))*1000)::text oldest_ready_ms,count(*)FILTER(WHERE state='scheduled'AND current_attempt>1)::integer backoff,count(*)FILTER(WHERE state='scheduled'AND current_attempt>1 AND run_at<=clock_timestamp()+interval '5 minutes')::integer due_soon,count(*)FILTER(WHERE state='active')::integer active,count(*)FILTER(WHERE state='active'AND expires_at<=clock_timestamp())::integer expired,count(*)FILTER(WHERE state='active'AND expires_at>clock_timestamp()AND expires_at<=clock_timestamp()+interval '30 seconds')::integer expiring_soon,count(*)FILTER(WHERE state='scheduled'AND run_at<clock_timestamp()-interval '30 seconds')::integer due_but_unpromoted FROM workhorse.dashboard_job_runtime_v1`)
	if err != nil {
		return nil, err
	}
	runtime := runtimeRows[0]
	queuesValue, err := service.jsonQuery(ctx, `WITH rolled AS(SELECT queue_name,COALESCE(sum(enqueued),0)::integer enqueued,COALESCE(sum(`+completed+`),0)::integer completed FROM `+stat+` GROUP BY 1),names AS(SELECT queue_name FROM workhorse.dashboard_job_runtime_v1 UNION SELECT queue_name FROM workhorse.dashboard_queue_control_v1 UNION SELECT queue_name FROM workhorse.dashboard_concurrency_policy_v1 UNION SELECT queue_name FROM workhorse.dashboard_rate_limit_policy_v1 UNION SELECT queue_name FROM rolled),runtime AS(SELECT queue_name,count(*)FILTER(WHERE state='ready')::integer ready,(extract(epoch FROM clock_timestamp()-min(ready_at)FILTER(WHERE state='ready'))*1000)::text oldest_ready_ms,count(*)FILTER(WHERE state='scheduled'AND run_at<=clock_timestamp()+interval '5 minutes')::integer due_soon,count(*)FILTER(WHERE state='active')::integer active,count(*)FILTER(WHERE state='scheduled'AND current_attempt>1)::integer retrying FROM workhorse.dashboard_job_runtime_v1 GROUP BY queue_name),priorities AS(SELECT r.queue_name,j.priority,count(*)::integer ready,(extract(epoch FROM clock_timestamp()-min(r.ready_at))*1000)::text oldest_ready_ms FROM workhorse.dashboard_job_runtime_v1 r JOIN workhorse.dashboard_job_v1 j ON j.id=r.job_id WHERE r.state='ready'GROUP BY r.queue_name,j.priority),rows AS(SELECT n.queue_name queue,COALESCE(c.paused,false)paused,COALESCE(r.ready,0)::integer ready,r.oldest_ready_ms,COALESCE(r.due_soon,0)::integer due_soon,COALESCE(r.active,0)::integer active,COALESCE(r.retrying,0)::integer retrying,COALESCE(s.enqueued,0)::integer enqueued,COALESCE(s.completed,0)::integer completed FROM names n LEFT JOIN workhorse.dashboard_queue_control_v1 c USING(queue_name)LEFT JOIN runtime r USING(queue_name)LEFT JOIN rolled s USING(queue_name)ORDER BY n.queue_name)SELECT COALESCE(jsonb_agg(jsonb_build_object('queue',queue,'paused',paused,'ready',ready,'oldestReadyMs',oldest_ready_ms,'priorityBacklog',COALESCE((SELECT jsonb_agg(jsonb_build_object('priority',priority,'ready',ready,'oldestReadyMs',oldest_ready_ms)ORDER BY priority DESC)FROM priorities p WHERE p.queue_name=rows.queue),'[]'::jsonb),'dueSoon',due_soon,'active',active,'retrying',retrying,'enqueuedPerMinute',enqueued/($1::double precision/60),'completedPerMinute',completed/($1::double precision/60),'concurrencyPolicy',NULL,'rateLimitPolicy',NULL)ORDER BY queue),'[]'::jsonb)result FROM rows`, seconds)
	if err != nil {
		return nil, err
	}
	queues := queuesValue.([]any)
	failing, err := service.jsonQuery(ctx, `WITH rows AS(SELECT queue_name queue,job_type type,sum(`+attempts+`)::integer attempts,sum(`+errors+`)::integer errors,sum(attempt_failed)::integer terminal_failures,(array_agg(last_error ORDER BY last_error_at DESC NULLS LAST)FILTER(WHERE last_error IS NOT NULL))[1]last_error,max(last_attempt_at)last_seen_at FROM `+stat+` GROUP BY 1,2 HAVING sum(`+errors+`)>0 ORDER BY errors DESC,last_seen_at DESC LIMIT 8)SELECT COALESCE(jsonb_agg(jsonb_build_object('queue',queue,'type',type,'attempts',attempts,'errorRate',errors::double precision/attempts,'terminalFailures',terminal_failures,'lastError',last_error,'lastSeenAt',last_seen_at)ORDER BY errors DESC,last_seen_at DESC),'[]'::jsonb)result FROM rows`, seconds)
	if err != nil {
		return nil, err
	}
	health, err := service.health(ctx)
	if err != nil {
		return nil, err
	}
	status := health["status"].(map[string]any)
	minutes := float64(seconds) / 60
	current := float64(integer(summary["errors"])) / maxOne(integer(summary["attempts"]))
	previous := float64(integer(summary["previous_errors"])) / maxOne(integer(summary["previous_attempts"]))
	if integer(summary["attempts"]) == 0 {
		current = 0
	}
	if integer(summary["previous_attempts"]) == 0 {
		previous = 0
	}
	retryRows, err := service.executor.Query(ctx, `SELECT CASE WHEN run_at<=clock_timestamp()+interval '1 minute' THEN 60000 WHEN run_at<=clock_timestamp()+interval '5 minutes' THEN 300000 WHEN run_at<=clock_timestamp()+interval '15 minutes' THEN 900000 WHEN run_at<=clock_timestamp()+interval '1 hour' THEN 3600000 ELSE NULL END upper_bound_ms,count(*)::integer count FROM workhorse.dashboard_job_runtime_v1 WHERE state='scheduled' AND current_attempt>1 GROUP BY 1`)
	if err != nil {
		return nil, err
	}
	retryCounts := make(map[string]int)
	for _, row := range retryRows {
		retryCounts[fmt.Sprint(row["upper_bound_ms"])] = integer(row["count"])
	}
	retries := []any{map[string]any{"upperBoundMs": 60000, "count": retryCounts["60000"]}, map[string]any{"upperBoundMs": 300000, "count": retryCounts["300000"]}, map[string]any{"upperBoundMs": 900000, "count": retryCounts["900000"]}, map[string]any{"upperBoundMs": 3600000, "count": retryCounts["3600000"]}, map[string]any{"upperBoundMs": nil, "count": retryCounts["<nil>"]}}
	retryTypes, err := service.jsonQuery(ctx, `WITH rows AS(SELECT j.queue_name queue,j.job_type type,count(*)::integer count FROM workhorse.dashboard_job_runtime_v1 r JOIN workhorse.dashboard_job_v1 j ON j.id=r.job_id WHERE r.state='scheduled' AND r.current_attempt>1 GROUP BY j.queue_name,j.job_type ORDER BY count DESC,j.queue_name,j.job_type LIMIT 3)SELECT COALESCE(jsonb_agg(jsonb_build_object('queue',queue,'type',type,'count',count)ORDER BY count DESC,queue,type),'[]'::jsonb)result FROM rows`)
	if err != nil {
		return nil, err
	}
	concurrency, rateLimits, concurrencyCapped, rateCapped := admissionPolicies(health)
	paused := []any{}
	for _, item := range queues {
		row := item.(map[string]any)
		name := fmt.Sprint(row["queue"])
		row["concurrencyPolicy"] = concurrency[name]
		row["rateLimitPolicy"] = rateLimits[name]
		if row["paused"].(bool) {
			paused = append(paused, row["queue"])
		}
	}
	dependencies := map[string]any{"blockedJobs": integer(health["dependency_blocked_jobs"]), "pendingEdges": integer(health["dependency_pending_edges"]), "failedResolutions": integer(health["dependency_failed_resolutions"]), "retentionPruneStarved": health["dependency_retention_prune_starved"], "capped": health["dependency_counts_capped"]}
	children := map[string]any{"waitingParents": integer(health["child_waiting_parents"]), "pendingChildren": integer(health["child_pending_children"]), "unjoinedResults": integer(health["child_unjoined_results"]), "failedParents": integer(health["child_failed_parents"]), "canceledParents": integer(health["child_canceled_parents"]), "capped": health["child_counts_capped"]}
	external := map[string]any{"pendingSignals": integer(health["pending_signal_waits"]), "pendingHumanDecisions": integer(health["pending_human_waits"]), "overdue": integer(health["overdue_external_waits"]), "oldestPendingAgeMs": nullableDecimal(health["oldest_external_wait_age_ms"]), "rejectedDeliveries": integer(health["rejected_wait_deliveries"]), "capped": health["external_wait_counts_capped"]}
	retention := systemRetention(health)
	storage := systemStorage(health, status)
	partitions := []any{}
	for _, item := range health["history_partition_days"].([]any) {
		row := item.(map[string]any)
		partitions = append(partitions, map[string]any{"day": row["day"], "startsAt": row["starts_at"], "eventExists": row["has_job_events"], "attemptExists": row["has_attempt_history"]})
	}
	return map[string]any{"capturedAt": timestamp(time.Now()), "window": window, "windowSeconds": seconds, "status": status, "pausedQueues": paused, "kpis": map[string]any{"drain": map[string]any{"enqueuedPerMinute": float64(integer(summary["enqueued"])) / minutes, "completedPerMinute": float64(integer(summary["completed"])) / minutes, "netPerMinute": float64(integer(summary["completed"])-integer(summary["enqueued"])) / minutes}, "backlog": map[string]any{"ready": runtime["ready"], "oldestReadyMs": runtime["oldest_ready_ms"]}, "errorRate": map[string]any{"current": current, "previous": previous, "delta": current - previous}, "queueWait": map[string]any{"p50Ms": decimal(wait["p50"]), "p95Ms": decimal(wait["p95"]), "p99Ms": decimal(wait["p99"])}, "retry": map[string]any{"backoff": runtime["backoff"], "dueSoon": runtime["due_soon"], "buckets": retries}, "lease": map[string]any{"active": runtime["active"], "expired": runtime["expired"], "expiringSoon": runtime["expiring_soon"], "recovered": summary["recovered"]}, "dependencies": dependencies, "children": children, "externalWaits": external, "deadline": map[string]any{"pending": integer(health["pending_deadlines"]), "overdue": integer(health["overdue_deadlines"]), "dueWithinMinute": integer(health["deadlines_due_within_minute"]), "earliestAt": health["earliest_deadline_at"], "activeTimeouts": integer(health["active_execution_timeouts"]), "overdueTimeouts": integer(health["overdue_execution_timeouts"])}}, "outcomes": outcomes, "queues": queues, "concurrencyPoliciesCapped": concurrencyCapped, "rateLimitPoliciesCapped": rateCapped, "retryStorm": map[string]any{"buckets": retries, "topTypes": retryTypes}, "failingTypes": failing, "integrity": map[string]any{"dueButUnpromoted": runtime["due_but_unpromoted"], "partitions": partitions, "defaultEventRows": integer(health["default_event_rows"]), "defaultAttemptRows": integer(health["default_attempt_rows"]), "retention": retention, "storage": storage}}, nil
}

func maxOne(value int) float64 {
	if value < 1 {
		return 1
	}
	return float64(value)
}

func nullableDecimal(value any) any {
	if value == nil {
		return nil
	}
	return decimal(value)
}

func systemRetention(health map[string]any) map[string]any {
	specs := [][5]any{{"jobIdentity", "job_identity_retention_days", "job_identity_lag_ms", "oldest_job_identity_at", false}, {"terminalOutcome", "terminal_outcome_retention_days", "terminal_outcome_lag_ms", "oldest_terminal_outcome_at", false}, {"jobEvents", "job_event_retention_days", "job_event_lag_ms", "oldest_job_event_at", true}, {"attemptHistory", "attempt_history_retention_days", "attempt_history_lag_ms", "oldest_attempt_history_at", true}, {"scheduleOccurrences", "schedule_occurrence_retention_days", "schedule_occurrence_lag_ms", "oldest_schedule_occurrence_at", false}, {"statistics", "statistics_retention_days", "statistics_lag_ms", "oldest_statistics_at", false}}
	categories := make([]any, 0, 6)
	var oldest map[string]any
	var maxLag map[string]any
	for _, spec := range specs {
		row := map[string]any{"category": spec[0], "retentionDays": health[spec[1].(string)], "lagMs": health[spec[2].(string)], "oldestRetainedAt": health[spec[3].(string)], "prunedByPartition": spec[4]}
		categories = append(categories, row)
		if row["oldestRetainedAt"] != nil && (oldest == nil || fmt.Sprint(row["oldestRetainedAt"]) < fmt.Sprint(oldest["oldestRetainedAt"])) {
			oldest = row
		}
		if row["lagMs"] != nil && decimal(row["lagMs"]) > 0 && (maxLag == nil || decimal(row["lagMs"]) > decimal(maxLag["lagMs"])) {
			maxLag = row
		}
	}
	var maxLagMs, maxLagCategory, oldestAt, oldestCategory any
	if maxLag != nil {
		maxLagMs, maxLagCategory = maxLag["lagMs"], maxLag["category"]
	}
	if oldest != nil {
		oldestAt, oldestCategory = oldest["oldestRetainedAt"], oldest["category"]
	}
	return map[string]any{"policyUpdatedAt": health["updated_at"], "categories": categories, "maxLagMs": maxLagMs, "maxLagCategory": maxLagCategory, "oldestRetainedAt": oldestAt, "oldestRetainedCategory": oldestCategory, "eligibleHistoryPartitions": map[string]any{"jobEvents": integer(health["eligible_event_partitions"]), "attemptHistory": integer(health["eligible_attempt_partitions"])}, "defaultHistoryRows": map[string]any{"jobEvents": integer(health["default_event_rows"]), "attemptHistory": integer(health["default_attempt_rows"])}, "defaultHistoryRowsCapped": map[string]any{"jobEvents": health["default_event_rows_capped"], "attemptHistory": health["default_attempt_rows_capped"]}}
}

func systemStorage(health, status map[string]any) map[string]any {
	names := []string{"job", "job_outcome", "job_runtime", "job_query", "job_event", "attempt_history", "schedule_occurrence", "job_stat_bucket", "job_stat_bucket_hour", "job_stat_bucket_day"}
	byName := map[string]map[string]any{}
	observations := health["observations"].(map[string]any)
	for _, item := range observations["relations"].([]any) {
		row := item.(map[string]any)
		byName[row["relation"].(string)] = row
	}
	relations := make([]map[string]any, 0, 10)
	total := 0
	for _, name := range names {
		row := byName[name]
		projected := map[string]any{"relation": name, "totalBytes": integer(row["total_bytes"]), "tableBytes": integer(row["table_bytes"]), "indexBytes": integer(row["index_bytes"]), "rows": integer(row["live_tuples"]), "deadRows": integer(row["dead_tuples"]), "partitions": integer(row["partitions"]), "lastVacuumAt": row["last_autovacuum"]}
		if projected["lastVacuumAt"] == nil {
			projected["lastVacuumAt"] = row["last_vacuum"]
		}
		relations = append(relations, projected)
		total += projected["totalBytes"].(int)
	}
	sort.SliceStable(relations, func(i, j int) bool { return relations[i]["totalBytes"].(int) > relations[j]["totalBytes"].(int) })
	items := make([]any, len(relations))
	for i, row := range relations {
		items[i] = row
	}
	stalled := false
	for _, item := range status["reasons"].([]any) {
		if item.(map[string]any)["code"] == "rollup-stalled" {
			stalled = true
		}
	}
	return map[string]any{"rollup": map[string]any{"rolledUpThrough": health["rolled_up_through"], "lagMs": decimal(health["rollup_lag_ms"]), "lastRunAt": health["last_run_at"], "buckets": integer(health["buckets"]), "oldestBucketAt": health["oldest_statistics_at"], "newestBucketAt": health["newest_bucket_at"], "stalled": stalled}, "relations": items, "totalBytes": total}
}
