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
	return service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_task_counts_v1('{}'::jsonb) AS result",
	)
}

func (service *backend) taskFacets(ctx context.Context, _ any, _ string) (any, error) {
	workers := service.configuredWorkers
	if workers == nil {
		workers = []string{}
	}
	return service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_task_facets_v1($1::jsonb) AS result",
		string(mustJSON(map[string]any{"configuredWorkers": workers})),
	)
}

func (service *backend) queues(ctx context.Context, _ any, _ string) (any, error) {
	return service.jsonQuery(
		ctx,
		"SELECT workhorse.dashboard_queues_v1('{}'::jsonb) AS result",
	)
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
