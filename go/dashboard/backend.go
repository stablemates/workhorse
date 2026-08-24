package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	workhorse "github.com/stablemates/workhorse/go"
)

type backend struct {
	executor          workhorse.Executor
	admin             *workhorse.Admin
	environment       string
	configuredWorkers []string
	readOnly          bool
	maintenanceLoops  map[string]int
	healthMu          sync.Mutex
	healthExpiresAt   time.Time
	healthValue       map[string]any
}

func (service *backend) procedures() map[string]Procedure {
	return map[string]Procedure{
		"meta": service.meta, "taskCounts": service.taskCounts,
		"taskFacets": service.taskFacets, "queues": service.queues,
		"tasks": service.tasks, "activity": service.activity,
		"cron": service.cron, "workers": service.workers, "humanWaits": service.humanWaits,
		"events": service.events, "eventDetail": service.eventDetail,
		"previewRetentionPolicy": service.previewRetentionPolicy,
		"jobDetail":              service.jobDetail, "settings": service.settings, "system": service.system,
		"setQueuePaused": service.setQueuePaused, "purgeQueue": service.purgeQueue,
		"setWorkerPaused":           service.setWorkerPaused,
		"overrideMaintenancePolicy": service.overrideMaintenancePolicy,
		"revertMaintenancePolicy":   service.revertMaintenancePolicy,
		"overrideRetentionPolicy":   service.overrideRetentionPolicy,
		"revertRetentionPolicy":     service.revertRetentionPolicy,
		"runTaskNow":                service.runTaskNow, "cancelTask": service.cancelTask,
		"signalTask": service.signalTask, "completeHumanWait": service.completeHumanWait,
	}
}

func (service *backend) jsonQuery(ctx context.Context, statement string, arguments ...any) (any, error) {
	rows, err := service.executor.Query(ctx, statement, arguments...)
	if err != nil {
		return nil, err
	}
	row, err := oneRow(rows, "dashboard JSON projection")
	if err != nil {
		return nil, err
	}
	value := row["result"]
	return decodeJSONCell(value)
}

func decodeJSONCell(value any) (any, error) {
	var decoded any
	switch encoded := value.(type) {
	case []byte:
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			return nil, err
		}
		return normalizeJSON(decoded), nil
	case string:
		if err := json.Unmarshal([]byte(encoded), &decoded); err != nil {
			return nil, err
		}
		return normalizeJSON(decoded), nil
	default:
		return normalizeJSON(value), nil
	}
}

func normalizeJSON(value any) any {
	switch current := value.(type) {
	case map[string]any:
		for key, item := range current {
			current[key] = normalizeJSON(item)
		}
	case []any:
		for index, item := range current {
			current[index] = normalizeJSON(item)
		}
	case string:
		if strings.Contains(current, "T") {
			if moment, err := time.Parse(time.RFC3339Nano, current); err == nil {
				return moment.UTC().Format("2006-01-02T15:04:05.000Z")
			}
		}
	}
	return value
}

func (service *backend) meta(context.Context, any, string) (any, error) {
	return map[string]any{"environment": service.environment}, nil
}

func (service *backend) taskCounts(ctx context.Context, _ any, _ string) (any, error) {
	estimateRows, err := service.executor.Query(ctx, "SELECT estimate FROM workhorse.dashboard_job_estimate_v1()")
	if err != nil {
		return nil, err
	}
	estimate := integer(estimateRows[0]["estimate"])
	if estimate >= 50_000 {
		liveRows, queryErr := service.executor.Query(ctx, `SELECT count(*)FILTER(WHERE state='blocked')::integer blocked,count(*)FILTER(WHERE EXISTS(SELECT 1 FROM workhorse.dashboard_signal_wait_v1 s WHERE s.job_id=runtime.job_id UNION ALL SELECT 1 FROM workhorse.dashboard_human_wait_v1 h WHERE h.job_id=runtime.job_id))::integer waiting,count(*)FILTER(WHERE state='scheduled')::integer scheduled,count(*)FILTER(WHERE state='ready')::integer queued,count(*)FILTER(WHERE state='active')::integer running,count(*)FILTER(WHERE current_attempt>1)::integer retried FROM workhorse.dashboard_job_runtime_v1 runtime`)
		if queryErr != nil {
			return nil, queryErr
		}
		live := liveRows[0]
		completed, queryErr := service.estimateRows(ctx, "SELECT 1 FROM workhorse.dashboard_job_outcome_v1 WHERE state='succeeded'")
		if queryErr != nil {
			return nil, queryErr
		}
		discarded, queryErr := service.estimateRows(ctx, "SELECT 1 FROM workhorse.dashboard_job_outcome_v1 WHERE state='failed'")
		if queryErr != nil {
			return nil, queryErr
		}
		canceled, queryErr := service.estimateRows(ctx, "SELECT 1 FROM workhorse.dashboard_job_outcome_v1 WHERE state='canceled'")
		if queryErr != nil {
			return nil, queryErr
		}
		retried, queryErr := service.estimateRows(ctx, "SELECT 1 FROM workhorse.dashboard_job_outcome_v1 WHERE current_attempt>1")
		if queryErr != nil {
			return nil, queryErr
		}
		return map[string]any{"all": estimate, "blocked": live["blocked"], "waiting": live["waiting"], "scheduled": live["scheduled"], "retried": integer(live["retried"]) + retried, "queued": live["queued"], "running": live["running"], "completed": completed, "discarded": discarded, "canceled": canceled}, nil
	}
	rows, err := service.executor.Query(ctx, `
WITH tasks AS (
  SELECT COALESCE(r.state, o.state) AS state,
         EXISTS (
           SELECT 1 FROM workhorse.dashboard_signal_wait_v1 s WHERE s.job_id = j.id
           UNION ALL
           SELECT 1 FROM workhorse.dashboard_human_wait_v1 h WHERE h.job_id = j.id
         ) AS external_wait,
         COALESCE(r.current_attempt, o.current_attempt) AS attempt
    FROM workhorse.dashboard_job_v1 j
    LEFT JOIN workhorse.dashboard_job_runtime_v1 r ON r.job_id = j.id
    LEFT JOIN workhorse.dashboard_job_outcome_v1 o ON o.job_id = j.id
)
SELECT count(*)::integer AS all,
       count(*) FILTER (WHERE state = 'blocked')::integer AS blocked,
       count(*) FILTER (WHERE external_wait)::integer AS waiting,
       count(*) FILTER (WHERE state = 'scheduled')::integer AS scheduled,
       count(*) FILTER (WHERE attempt > 1)::integer AS retried,
       count(*) FILTER (WHERE state = 'ready')::integer AS queued,
       count(*) FILTER (WHERE state = 'active')::integer AS running,
       count(*) FILTER (WHERE state = 'succeeded')::integer AS completed,
       count(*) FILTER (WHERE state = 'failed')::integer AS discarded,
       count(*) FILTER (WHERE state = 'canceled')::integer AS canceled
  FROM tasks`)
	if err != nil {
		return nil, err
	}
	return oneRow(rows, "task counts")
}

func (service *backend) taskFacets(ctx context.Context, _ any, _ string) (any, error) {
	rows, err := service.executor.Query(ctx, `
WITH configured_workers(worker) AS (SELECT unnest($1::text[])),
queue_values AS (
  SELECT queue_name AS value FROM workhorse.dashboard_job_v1
  UNION SELECT queue_name FROM workhorse.dashboard_queue_control_v1
), worker_values AS (
  SELECT worker AS value FROM configured_workers
  UNION SELECT worker_id FROM workhorse.dashboard_job_runtime_v1 WHERE worker_id IS NOT NULL
  UNION SELECT worker_id FROM workhorse.dashboard_attempt_history_v1 WHERE worker_id IS NOT NULL
), type_values AS (
  SELECT DISTINCT job_type AS value FROM workhorse.dashboard_job_v1
), tag_values AS (
  SELECT DISTINCT unnest(tags) AS value FROM workhorse.dashboard_job_v1
)
SELECT ARRAY(SELECT value FROM queue_values WHERE value IS NOT NULL ORDER BY value) AS queues,
       ARRAY(SELECT value FROM worker_values WHERE value IS NOT NULL ORDER BY value) AS workers,
       ARRAY(SELECT value FROM type_values ORDER BY value) AS job_types,
       ARRAY(SELECT value FROM tag_values ORDER BY value) AS tags`, service.configuredWorkers)
	if err != nil {
		return nil, err
	}
	row, err := oneRow(rows, "task facets")
	if err != nil {
		return nil, err
	}
	return map[string]any{"queues": stringValues(row["queues"]), "workers": stringValues(row["workers"]), "jobTypes": stringValues(row["job_types"]), "tags": stringValues(row["tags"])}, nil
}

func (service *backend) queues(ctx context.Context, _ any, _ string) (any, error) {
	return service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_queues_v1('{}'::jsonb) AS result",
	)
}

func (service *backend) estimateRows(ctx context.Context, statement string, arguments ...any) (int, error) {
	rows, err := service.executor.Query(ctx, "EXPLAIN (FORMAT JSON) "+statement, arguments...)
	if err != nil {
		return 0, err
	}
	row, err := oneRow(rows, "row estimate")
	if err != nil {
		return 0, err
	}
	var value any
	for _, cell := range row {
		value, err = decodeJSONCell(cell)
		if err != nil {
			return 0, err
		}
		break
	}
	plans, ok := value.([]any)
	if !ok || len(plans) == 0 {
		return 0, fmt.Errorf("row estimate returned %T", value)
	}
	document, ok := plans[0].(map[string]any)
	if !ok {
		return 0, fmt.Errorf("row estimate plan returned %T", plans[0])
	}
	plan, ok := document["Plan"].(map[string]any)
	if !ok {
		return 0, fmt.Errorf("row estimate document omitted Plan")
	}
	return max(0, integer(plan["Plan Rows"])), nil
}

func admissionPolicies(health map[string]any) (map[string]any, map[string]any, bool, bool) {
	concurrency, rateLimits := make(map[string]any), make(map[string]any)
	concurrencyCapped, rateCapped := false, false
	for _, item := range health["concurrency_policies"].([]any) {
		row := item.(map[string]any)
		active, maximum := integer(row["active"]), integer(row["max_active"])
		concurrency[fmt.Sprint(row["queue_name"])] = map[string]any{
			"namespace": row["namespace"], "maxActive": maximum, "utilizationKnown": true,
			"active": active, "available": max(0, maximum-active),
			"blockedReady": integer(row["blocked_ready"]), "maxActivePerKey": nullableInteger(row["max_active_per_key"]),
			"saturatedKeys": integer(row["saturated_keys"]), "highestKeyActive": integer(row["highest_key_active"]),
		}
		if capped, _ := row["capped"].(bool); capped {
			concurrencyCapped = true
		}
	}
	for _, item := range health["rate_limit_policies"].([]any) {
		row := item.(map[string]any)
		var perKey any
		if row["per_key_limit"] != nil {
			perKey = map[string]any{"limit": integer(row["per_key_limit"]), "intervalMs": integer(row["per_key_interval_ms"]), "burst": integer(row["per_key_burst"])}
		}
		rateLimits[fmt.Sprint(row["queue_name"])] = map[string]any{
			"namespace": row["namespace"],
			"rate":      map[string]any{"limit": integer(row["rate_limit"]), "intervalMs": integer(row["rate_interval_ms"]), "burst": integer(row["rate_burst"])},
			"perKey":    perKey, "availableTokens": decimal(row["available_tokens"]),
			"throttledReady": integer(row["throttled_ready"]), "throttledKeys": integer(row["throttled_keys"]),
			"nextEligibleAt": timestamp(row["next_eligible_at"]),
		}
		policyCapped, _ := row["policy_set_capped"].(bool)
		sampleCapped, _ := row["sample_capped"].(bool)
		rateCapped = rateCapped || policyCapped || sampleCapped
	}
	return concurrency, rateLimits, concurrencyCapped, rateCapped
}

func nullableInteger(value any) any {
	if value == nil {
		return nil
	}
	return integer(value)
}

func oneRow(rows []workhorse.Row, name string) (workhorse.Row, error) {
	if len(rows) != 1 {
		return nil, fmt.Errorf("%s returned %d rows", name, len(rows))
	}
	return rows[0], nil
}

func timestamp(value any) any {
	if value == nil {
		return nil
	}
	if moment, ok := value.(time.Time); ok {
		return moment.UTC().Format(time.RFC3339Nano)
	}
	return value
}

func mustJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}
