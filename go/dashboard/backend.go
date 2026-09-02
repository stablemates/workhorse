package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
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
				return moment.UTC().Format(dashboardTimestampLayout)
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

func oneRow(rows []workhorse.Row, name string) (workhorse.Row, error) {
	if len(rows) != 1 {
		return nil, fmt.Errorf("%s returned %d rows", name, len(rows))
	}
	return rows[0], nil
}

// One instant must serialize to one string in every language, so this is the layout the whole
// dashboard uses. It matches JavaScript `Date.toISOString()` and Python
// `isoformat(timespec="milliseconds")`: UTC, always three fractional digits.
//
// `time.RFC3339Nano` cannot be used here. It drops trailing zeros, so a whole second becomes
// `...T00:00:00Z` where the other two backends write `...T00:00:00.000Z`, and it keeps microsecond
// precision PostgreSQL supplies where the other two truncate to milliseconds.
const dashboardTimestampLayout = "2006-01-02T15:04:05.000Z"

func timestamp(value any) any {
	if value == nil {
		return nil
	}
	if moment, ok := value.(time.Time); ok {
		return moment.UTC().Format(dashboardTimestampLayout)
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
