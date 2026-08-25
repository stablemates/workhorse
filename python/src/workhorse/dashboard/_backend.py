# ruff: noqa: E501
from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from threading import Lock
from time import monotonic
from typing import cast

from .._drivers import SyncExecutor
from .._statements import DriverStatement
from ..admin import Admin, AdminAudit
from ._errors import DashboardRPCError


def _statement(sql: str) -> DriverStatement:
    return DriverStatement(psycopg=sql, asyncpg=sql)


def _iso(value: object) -> object:
    if isinstance(value, datetime):
        return (
            value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        )
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, Mapping):
        return {str(key): _iso(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, str | bytes):
        return [_iso(item) for item in value]
    return value


def _integer(value: object) -> int:
    return 0 if value is None else int(cast(int | str, value))


def _float_or_none(value: object) -> float | None:
    return None if value is None else float(cast(float | int | str, value))


def _admission_policies(
    health: Mapping[str, object],
) -> tuple[dict[str, object], dict[str, object]]:
    concurrency: dict[str, object] = {}
    for raw in cast(Sequence[Mapping[str, object]], health["concurrency_policies"]):
        active = _integer(raw["active"])
        maximum = _integer(raw["max_active"])
        concurrency[cast(str, raw["queue_name"])] = {
            "namespace": raw["namespace"],
            "maxActive": maximum,
            "utilizationKnown": True,
            "active": active,
            "available": max(0, maximum - active),
            "blockedReady": _integer(raw["blocked_ready"]),
            "maxActivePerKey": None
            if raw["max_active_per_key"] is None
            else _integer(raw["max_active_per_key"]),
            "saturatedKeys": _integer(raw["saturated_keys"]),
            "highestKeyActive": _integer(raw["highest_key_active"]),
        }
    rate_limits: dict[str, object] = {}
    for raw in cast(Sequence[Mapping[str, object]], health["rate_limit_policies"]):
        per_key = None
        if raw["per_key_limit"] is not None:
            per_key = {
                "limit": _integer(raw["per_key_limit"]),
                "intervalMs": _integer(raw["per_key_interval_ms"]),
                "burst": _integer(raw["per_key_burst"]),
            }
        rate_limits[cast(str, raw["queue_name"])] = {
            "namespace": raw["namespace"],
            "rate": {
                "limit": _integer(raw["rate_limit"]),
                "intervalMs": _integer(raw["rate_interval_ms"]),
                "burst": _integer(raw["rate_burst"]),
            },
            "perKey": per_key,
            "availableTokens": float(cast(float | int | str, raw["available_tokens"])),
            "throttledReady": _integer(raw["throttled_ready"]),
            "throttledKeys": _integer(raw["throttled_keys"]),
            "nextEligibleAt": _iso(raw["next_eligible_at"]),
        }
    return concurrency, rate_limits


class DashboardBackend:
    def __init__(
        self,
        executor: SyncExecutor,
        *,
        environment: str,
        configured_workers: Sequence[str],
        maintenance_loops: Mapping[str, int],
        read_only: bool,
    ) -> None:
        self._executor = executor
        self._admin = Admin._from_executor(executor)
        self._environment = environment
        self._configured_workers = tuple(configured_workers)
        self._maintenance_loops = dict(maintenance_loops)
        self._read_only = read_only
        self._health_cache: tuple[float, Mapping[str, object]] | None = None
        self._health_lock = Lock()

    def procedures(self) -> dict[str, Callable[[object, str], object]]:
        return {
            "meta": self.meta,
            "taskCounts": self.task_counts,
            "tasks": self.tasks,
            "activity": self.activity,
            "taskFacets": self.task_facets,
            "queues": self.queues,
            "cron": self.cron,
            "workers": self.workers,
            "humanWaits": self.human_waits,
            "events": self.events,
            "eventDetail": self.event_detail,
            "jobDetail": self.job_detail,
            "settings": self.settings,
            "system": self.system,
            "previewRetentionPolicy": self.preview_retention_policy,
            "setQueuePaused": self.set_queue_paused,
            "purgeQueue": self.purge_queue,
            "setWorkerPaused": self.set_worker_paused,
            "overrideMaintenancePolicy": self.override_maintenance_policy,
            "revertMaintenancePolicy": self.revert_maintenance_policy,
            "overrideRetentionPolicy": self.override_retention_policy,
            "revertRetentionPolicy": self.revert_retention_policy,
            "runTaskNow": self.run_task_now,
            "cancelTask": self.cancel_task,
            "signalTask": self.signal_task,
            "completeHumanWait": self.complete_human_wait,
        }

    def _rows(self, sql: str, parameters: Sequence[object] = ()) -> list[Mapping[str, object]]:
        return self._executor.rows(_statement(sql), parameters)

    def _json_result(self, sql: str, parameters: Sequence[object] = ()) -> object:
        value = self._rows(sql, parameters)[0]["result"]
        return _iso(json.loads(value) if isinstance(value, str | bytes) else value)

    def _health(self) -> Mapping[str, object]:
        cached = self._health_cache
        if cached is not None and cached[0] > monotonic():
            return cached[1]
        with self._health_lock:
            cached = self._health_cache
            if cached is not None and cached[0] > monotonic():
                return cached[1]
            value = self._rows("SELECT workhorse.queue_health_v1() AS snapshot")[0]["snapshot"]
            if isinstance(value, str | bytes):
                value = json.loads(value)
            if not isinstance(value, Mapping):
                raise TypeError("workhorse.queue_health_v1 returned a non-object snapshot")
            self._health_cache = (monotonic() + 3, value)
            return value

    def meta(self, _input: object, _actor: str) -> object:
        return {"environment": self._environment}

    def task_counts(self, _input: object, _actor: str) -> object:
        return self._json_result("SELECT workhorse.dashboard_task_counts_v1('{}'::jsonb) AS result")

    def tasks(self, input: object, _actor: str) -> object:
        supplied = cast(Mapping[str, object], input)
        query: dict[str, object] = {
            "filter": "all",
            "queue": None,
            "page": 1,
            "worker": None,
            "jobType": None,
            "priority": None,
            "sort": "updated",
            "tags": [],
            "search": None,
            "pageSize": 50,
            **supplied,
            "canCompleteHumanWait": not self._read_only,
        }
        return self._json_result(
            "SELECT workhorse.dashboard_tasks_v1(%s::jsonb) AS result",
            (json.dumps(query),),
        )

    def activity(self, input: object, _actor: str) -> object:
        value = self._rows(
            "SELECT workhorse.dashboard_activity_v1(%s::jsonb) AS result",
            (json.dumps(input),),
        )[0]["result"]
        return _iso(json.loads(value) if isinstance(value, str | bytes) else value)

    def task_facets(self, _input: object, _actor: str) -> object:
        return self._json_result(
            "SELECT workhorse.dashboard_task_facets_v1(%s::jsonb) AS result",
            (json.dumps({"configuredWorkers": list(self._configured_workers)}),),
        )

    def queues(self, _input: object, _actor: str) -> object:
        return self._json_result("SELECT workhorse.dashboard_queues_v1('{}'::jsonb) AS result")

    def workers(self, _input: object, _actor: str) -> object:
        return self._json_result(
            "SELECT workhorse.dashboard_workers_v1(%s::jsonb) AS result",
            (
                json.dumps(
                    {
                        "configuredWorkers": list(self._configured_workers),
                        "canManageWorkers": not self._read_only,
                    }
                ),
            ),
        )

    def human_waits(self, _input: object, _actor: str) -> object:
        value = self._rows(
            "SELECT workhorse.dashboard_human_waits_v1(%s::jsonb) AS result",
            (json.dumps({"canComplete": not self._read_only, "canSignal": not self._read_only}),),
        )[0]["result"]
        return _iso(json.loads(value) if isinstance(value, str | bytes) else value)

    def events(self, input: object, _actor: str) -> object:
        value = self._rows(
            "SELECT workhorse.dashboard_events_v1(%s::jsonb) AS result",
            (json.dumps(input),),
        )[0]["result"]
        return _iso(json.loads(value) if isinstance(value, str | bytes) else value)

    def event_detail(self, input: object, _actor: str) -> object:
        value = self._rows(
            "SELECT workhorse.dashboard_event_detail_v1(%s::jsonb) AS result",
            (json.dumps(input),),
        )[0]["result"]
        if value is None:
            raise DashboardRPCError(404, "NOT_FOUND", "Event not found")
        return _iso(json.loads(value) if isinstance(value, str | bytes) else value)

    def job_detail(self, input: object, _actor: str) -> object:
        supplied = cast(Mapping[str, object], input)
        value = self._rows(
            "SELECT workhorse.dashboard_job_detail_v1(%s::jsonb) AS result",
            (json.dumps({**supplied, "canSignal": not self._read_only}),),
        )[0]["result"]
        if value is None:
            raise DashboardRPCError(404, "NOT_FOUND", "Task not found")
        return _iso(json.loads(value) if isinstance(value, str | bytes) else value)

    def settings(self, _input: object, _actor: str) -> object:
        maintenance = self._rows(
            "SELECT (policy).* FROM workhorse.get_maintenance_policy_v1() policy"
        )[0]
        retention = self._rows("SELECT (policy).* FROM workhorse.get_retention_policy_v1() policy")[
            0
        ]
        health = self._health()
        enqueued = self._rows(
            """SELECT COALESCE(sum(enqueued), 0)::integer AS jobs
                 FROM workhorse.stat_buckets_v1(
                   date_bin('1 minute', clock_timestamp(), timestamp with time zone '2000-01-01')
                     - interval '1 hour' + interval '1 minute', clock_timestamp())"""
        )[0]
        workers = self._rows(
            """SELECT worker_id, queue_names, concurrency, lease_ms, heartbeat_ms, poll_ms,
                      maintenance_interval_ms, maintenance_task_poll_ms, registry_interval_ms,
                      last_heartbeat_at FROM workhorse.dashboard_worker_registry_v1
                WHERE last_heartbeat_at >= clock_timestamp() - GREATEST(
                  interval '30 seconds', registry_interval_ms * 3 * interval '1 millisecond')
                ORDER BY worker_id"""
        )
        maintenance_names = (
            "timezone",
            "partitionPreparationIntervalMs",
            "terminalCleanupIntervalMs",
            "historyRetentionLocalTime",
            "statisticsRollupIntervalMs",
            "statisticsGroupLimit",
            "statisticsRecomputeBuckets",
        )
        retention_names = (
            "jobIdentityRetentionDays",
            "terminalOutcomeRetentionDays",
            "jobEventRetentionDays",
            "attemptHistoryRetentionDays",
            "scheduleOccurrenceRetentionDays",
            "statisticsRetentionDays",
            "terminalJobPruneLimit",
            "historyPartitionsPerPass",
            "defaultPartitionRowsPerPass",
            "occurrenceRowsPerPass",
            "statisticsRowsPerPass",
        )

        def policy(row: Mapping[str, object], names: Sequence[str]) -> dict[str, object]:
            overrides = set(cast(Sequence[str], row["operator_overrides"]))
            result: dict[str, object] = {}
            provenance: dict[str, object] = {}
            for name in names:
                column = _camel_to_snake(name)
                value = row[column]
                application = row["application_" + column]
                if name == "historyRetentionLocalTime":
                    value, application = str(value)[:5], str(application)[:5]
                result[name] = value
                provenance[name] = {
                    "source": "operator" if column in overrides else "application",
                    "applicationDefault": application,
                }
            result["provenance"] = provenance
            result["updatedAt"] = _iso(row["updated_at"])
            return result

        reasons = cast(Mapping[str, object], health["status"])["reasons"]
        return {
            "capturedAt": _iso(datetime.now(timezone.utc)),
            "editable": not self._read_only,
            "maintenance": policy(maintenance, maintenance_names),
            "retention": policy(retention, retention_names),
            "recommendationInputs": {
                "reasons": reasons,
                "statistics": {
                    "rolledUpThrough": _iso(health["rolled_up_through"]),
                    "lagMs": float(cast(float, health["rollup_lag_ms"])),
                    "lastRunAt": _iso(health["last_run_at"]),
                },
                "defaultHistoryRows": {
                    "jobEvents": int(cast(int, health["default_event_rows"])),
                    "attemptHistory": int(cast(int, health["default_attempt_rows"])),
                },
                "defaultHistoryRowsCapped": {
                    "jobEvents": health["default_event_rows_capped"],
                    "attemptHistory": health["default_attempt_rows_capped"],
                },
                "enqueueRate": {"jobs": enqueued["jobs"], "windowMs": 3_600_000},
            },
            "workers": [
                {
                    "id": row["worker_id"],
                    "queue": cast(Sequence[str], row["queue_names"])[0],
                    "queues": row["queue_names"],
                    "concurrency": row["concurrency"],
                    "leaseMs": row["lease_ms"],
                    "heartbeatMs": row["heartbeat_ms"],
                    "pollMs": row["poll_ms"],
                    "maintenanceIntervalMs": row["maintenance_interval_ms"],
                    "maintenanceTaskPollMs": row["maintenance_task_poll_ms"],
                    "registryIntervalMs": row["registry_interval_ms"],
                    "lastSeenAt": _iso(row["last_heartbeat_at"]),
                }
                for row in workers
            ],
        }

    def system(self, input: object, _actor: str) -> object:
        supplied = cast(Mapping[str, object], input)
        window = cast(str, supplied.get("window", "1h"))
        seconds = {"15m": 900, "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800}[window]
        start = "date_bin('1 minute', clock_timestamp(), timestamp with time zone '2000-01-01') - make_interval(secs => %s) + interval '1 minute'"
        stat = f"workhorse.stat_buckets_v1({start}, clock_timestamp())"
        outcomes = self._rows(
            f"""WITH buckets AS (SELECT generate_series({start},
                    date_bin('1 minute', clock_timestamp(), timestamp with time zone '2000-01-01'),
                    interval '1 minute') AS bucket_start), rolled AS (
                  SELECT bucket_start, sum(enqueued)::integer AS enqueued,
                    sum(attempt_succeeded)::integer AS succeeded,
                    sum(attempt_failed)::integer AS failed, sum(attempt_retry)::integer AS retry,
                    sum(attempt_lease_expired)::integer AS lease_expired,
                    sum(attempt_canceled)::integer AS canceled FROM {stat} GROUP BY 1)
                SELECT b.bucket_start, COALESCE(r.enqueued,0)::integer AS enqueued,
                  COALESCE(r.succeeded,0)::integer AS succeeded, COALESCE(r.failed,0)::integer AS failed,
                  COALESCE(r.retry,0)::integer AS retry, COALESCE(r.lease_expired,0)::integer AS lease_expired,
                  COALESCE(r.canceled,0)::integer AS canceled FROM buckets b LEFT JOIN rolled r USING(bucket_start)
                ORDER BY b.bucket_start""",
            (seconds, seconds),
        )
        completed = "(attempt_succeeded + attempt_failed + attempt_canceled)"
        attempts_expr = "(attempt_succeeded + attempt_failed + attempt_retry + attempt_lease_expired + attempt_canceled + attempt_other)"
        errors_expr = "(attempt_failed + attempt_retry + attempt_lease_expired + attempt_other)"
        summary = self._rows(
            f"""WITH current_window AS (SELECT COALESCE(sum(enqueued),0)::integer AS enqueued,
                    COALESCE(sum({completed}),0)::integer AS completed,
                    COALESCE(sum({attempts_expr}),0)::integer AS attempts,
                    COALESCE(sum({errors_expr}),0)::integer AS errors,
                    COALESCE(sum(attempt_lease_expired),0)::integer AS recovered FROM {stat}),
                  previous_window AS (SELECT COALESCE(sum({attempts_expr}),0)::integer AS attempts,
                    COALESCE(sum({errors_expr}),0)::integer AS errors FROM workhorse.stat_buckets_v1(
                    date_bin('1 minute', clock_timestamp(), timestamp with time zone '2000-01-01')
                      - make_interval(secs => %s * 2) + interval '1 minute', {start}))
                SELECT c.enqueued, c.completed, c.attempts, c.errors, c.recovered,
                  p.attempts AS previous_attempts, p.errors AS previous_errors
                  FROM current_window c CROSS JOIN previous_window p""",
            (seconds, seconds, seconds),
        )[0]
        wait = self._rows(
            f"""WITH merged AS (SELECT workhorse.stat_sketch_merge_v1(array_agg(wait_sketch)) AS sketch FROM {stat})
                SELECT workhorse.stat_sketch_percentile_v1(sketch,0.50) AS p50,
                  workhorse.stat_sketch_percentile_v1(sketch,0.95) AS p95,
                  workhorse.stat_sketch_percentile_v1(sketch,0.99) AS p99 FROM merged""",
            (seconds,),
        )[0]
        runtime = self._rows(
            """SELECT count(*) FILTER (WHERE state='ready')::integer AS ready,
                    extract(epoch FROM clock_timestamp()-min(ready_at) FILTER(WHERE state='ready'))*1000 AS oldest_ready_ms,
                    count(*) FILTER(WHERE state='scheduled' AND current_attempt>1)::integer AS backoff,
                    count(*) FILTER(WHERE state='scheduled' AND current_attempt>1 AND run_at<=clock_timestamp()+interval '5 minutes')::integer AS due_soon,
                    count(*) FILTER(WHERE state='active')::integer AS active,
                    count(*) FILTER(WHERE state='active' AND expires_at<=clock_timestamp())::integer AS expired,
                    count(*) FILTER(WHERE state='active' AND expires_at>clock_timestamp() AND expires_at<=clock_timestamp()+interval '30 seconds')::integer AS expiring_soon,
                    count(*) FILTER(WHERE state='scheduled' AND run_at<clock_timestamp()-interval '30 seconds')::integer AS due_but_unpromoted
               FROM workhorse.dashboard_job_runtime_v1"""
        )[0]
        queue_rows = self._rows(
            f"""WITH rolled AS (SELECT queue_name, COALESCE(sum(enqueued),0)::integer AS enqueued,
                    COALESCE(sum({completed}),0)::integer AS completed FROM {stat} GROUP BY 1),
                  names AS (SELECT queue_name FROM workhorse.dashboard_job_runtime_v1 UNION SELECT queue_name FROM workhorse.dashboard_queue_control_v1 UNION SELECT queue_name FROM workhorse.dashboard_concurrency_policy_v1 UNION SELECT queue_name FROM workhorse.dashboard_rate_limit_policy_v1 UNION SELECT queue_name FROM rolled),
                  runtime AS (SELECT queue_name, count(*) FILTER(WHERE state='ready')::integer AS ready,
                    extract(epoch FROM clock_timestamp()-min(ready_at) FILTER(WHERE state='ready'))*1000 AS oldest_ready_ms,
                    count(*) FILTER(WHERE state='scheduled' AND run_at<=clock_timestamp()+interval '5 minutes')::integer AS due_soon,
                    count(*) FILTER(WHERE state='active')::integer AS active,
                    count(*) FILTER(WHERE state='scheduled' AND current_attempt>1)::integer AS retrying
                    FROM workhorse.dashboard_job_runtime_v1 GROUP BY queue_name)
                SELECT n.queue_name AS queue, COALESCE(c.paused,false) AS paused,
                  COALESCE(r.ready,0)::integer AS ready, r.oldest_ready_ms,
                  COALESCE(r.due_soon,0)::integer AS due_soon, COALESCE(r.active,0)::integer AS active,
                  COALESCE(r.retrying,0)::integer AS retrying, COALESCE(s.enqueued,0)::integer AS enqueued,
                  COALESCE(s.completed,0)::integer AS completed FROM names n
                  LEFT JOIN workhorse.dashboard_queue_control_v1 c USING(queue_name)
                  LEFT JOIN runtime r USING(queue_name) LEFT JOIN rolled s USING(queue_name)
                  ORDER BY n.queue_name""",
            (seconds,),
        )
        priorities = self._rows(
            """SELECT r.queue_name AS queue, j.priority, count(*)::integer AS ready,
                    extract(epoch FROM clock_timestamp()-min(r.ready_at))*1000 AS oldest_ready_ms
                 FROM workhorse.dashboard_job_runtime_v1 r JOIN workhorse.dashboard_job_v1 j ON j.id=r.job_id
                WHERE r.state='ready' GROUP BY r.queue_name,j.priority ORDER BY r.queue_name,j.priority DESC"""
        )
        retry_rows = self._rows(
            """SELECT CASE
                     WHEN run_at<=clock_timestamp()+interval '1 minute' THEN 60000
                     WHEN run_at<=clock_timestamp()+interval '5 minutes' THEN 300000
                     WHEN run_at<=clock_timestamp()+interval '15 minutes' THEN 900000
                     WHEN run_at<=clock_timestamp()+interval '1 hour' THEN 3600000
                     ELSE NULL END AS upper_bound_ms,
                   count(*)::integer AS count
                 FROM workhorse.dashboard_job_runtime_v1
                WHERE state='scheduled' AND current_attempt>1 GROUP BY 1"""
        )
        retry_types = self._rows(
            """SELECT job.queue_name AS queue,job.job_type AS type,count(*)::integer AS count
                 FROM workhorse.dashboard_job_runtime_v1 runtime
                 JOIN workhorse.dashboard_job_v1 job ON job.id=runtime.job_id
                WHERE runtime.state='scheduled' AND runtime.current_attempt>1
                GROUP BY job.queue_name,job.job_type
                ORDER BY count DESC,job.queue_name,job.job_type LIMIT 3"""
        )
        failing = self._rows(
            f"""SELECT queue_name AS queue, job_type AS type, sum({attempts_expr})::integer AS attempts,
                    sum({errors_expr})::integer AS errors, sum(attempt_failed)::integer AS terminal_failures,
                    (array_agg(last_error ORDER BY last_error_at DESC NULLS LAST) FILTER(WHERE last_error IS NOT NULL))[1] AS last_error,
                    max(last_attempt_at) AS last_seen_at FROM {stat} GROUP BY 1,2
                  HAVING sum({errors_expr})>0 ORDER BY errors DESC,last_seen_at DESC LIMIT 8""",
            (seconds,),
        )
        health = self._health()
        status = cast(Mapping[str, object], health["status"])
        retry_counts = {row["upper_bound_ms"]: _integer(row["count"]) for row in retry_rows}
        retries = [
            {"upperBoundMs": bound, "count": retry_counts.get(bound, 0)}
            for bound in (60000, 300000, 900000, 3600000, None)
        ]
        by_queue: dict[str, list[object]] = {}
        for row in priorities:
            by_queue.setdefault(cast(str, row["queue"]), []).append(
                {
                    "priority": row["priority"],
                    "ready": row["ready"],
                    "oldestReadyMs": str(row["oldest_ready_ms"]),
                }
            )
        minutes = seconds / 60
        concurrency_by_queue, rate_limits_by_queue = _admission_policies(health)
        queues = [
            {
                "queue": row["queue"],
                "paused": row["paused"],
                "ready": row["ready"],
                "oldestReadyMs": None
                if row["oldest_ready_ms"] is None
                else str(row["oldest_ready_ms"]),
                "priorityBacklog": by_queue.get(cast(str, row["queue"]), []),
                "dueSoon": row["due_soon"],
                "active": row["active"],
                "retrying": row["retrying"],
                "enqueuedPerMinute": cast(int, row["enqueued"]) / minutes,
                "completedPerMinute": cast(int, row["completed"]) / minutes,
                "concurrencyPolicy": concurrency_by_queue.get(cast(str, row["queue"])),
                "rateLimitPolicy": rate_limits_by_queue.get(cast(str, row["queue"])),
            }
            for row in queue_rows
        ]
        dependencies = {
            "blockedJobs": int(cast(int, health["dependency_blocked_jobs"])),
            "pendingEdges": int(cast(int, health["dependency_pending_edges"])),
            "failedResolutions": int(cast(int, health["dependency_failed_resolutions"])),
            "retentionPruneStarved": health["dependency_retention_prune_starved"],
            "capped": health["dependency_counts_capped"],
        }
        children = {
            "waitingParents": int(cast(int, health["child_waiting_parents"])),
            "pendingChildren": int(cast(int, health["child_pending_children"])),
            "unjoinedResults": int(cast(int, health["child_unjoined_results"])),
            "failedParents": int(cast(int, health["child_failed_parents"])),
            "canceledParents": int(cast(int, health["child_canceled_parents"])),
            "capped": health["child_counts_capped"],
        }
        external = {
            "pendingSignals": int(cast(int, health["pending_signal_waits"])),
            "pendingHumanDecisions": int(cast(int, health["pending_human_waits"])),
            "overdue": int(cast(int, health["overdue_external_waits"])),
            "oldestPendingAgeMs": _float_or_none(health["oldest_external_wait_age_ms"]),
            "rejectedDeliveries": int(cast(int, health["rejected_wait_deliveries"])),
            "capped": health["external_wait_counts_capped"],
        }
        categories = []
        category_specs = (
            (
                "jobIdentity",
                "job_identity_retention_days",
                "job_identity_lag_ms",
                "oldest_job_identity_at",
                False,
            ),
            (
                "terminalOutcome",
                "terminal_outcome_retention_days",
                "terminal_outcome_lag_ms",
                "oldest_terminal_outcome_at",
                False,
            ),
            (
                "jobEvents",
                "job_event_retention_days",
                "job_event_lag_ms",
                "oldest_job_event_at",
                True,
            ),
            (
                "attemptHistory",
                "attempt_history_retention_days",
                "attempt_history_lag_ms",
                "oldest_attempt_history_at",
                True,
            ),
            (
                "scheduleOccurrences",
                "schedule_occurrence_retention_days",
                "schedule_occurrence_lag_ms",
                "oldest_schedule_occurrence_at",
                False,
            ),
            (
                "statistics",
                "statistics_retention_days",
                "statistics_lag_ms",
                "oldest_statistics_at",
                False,
            ),
        )
        for name, days, lag, oldest, partitioned in category_specs:
            categories.append(
                {
                    "category": name,
                    "retentionDays": health[days],
                    "lagMs": health[lag],
                    "oldestRetainedAt": _iso(health[oldest]),
                    "prunedByPartition": partitioned,
                }
            )
        oldest_category = min(
            (row for row in categories if row["oldestRetainedAt"] is not None),
            key=lambda row: cast(str, row["oldestRetainedAt"]),
            default=None,
        )
        lag_category = max(
            (
                row
                for row in categories
                if row["lagMs"] is not None and cast(float, row["lagMs"]) > 0
            ),
            key=lambda row: cast(float, row["lagMs"]),
            default=None,
        )
        observed = {
            cast(str, row["relation"]): row
            for row in cast(Mapping[str, Sequence[Mapping[str, object]]], health["observations"])[
                "relations"
            ]
        }
        relation_names = (
            "job",
            "job_outcome",
            "job_runtime",
            "job_query",
            "job_event",
            "attempt_history",
            "schedule_occurrence",
            "job_stat_bucket",
            "job_stat_bucket_hour",
            "job_stat_bucket_day",
        )
        relations = [
            {
                "relation": name,
                "totalBytes": int(cast(int, observed[name]["total_bytes"])),
                "tableBytes": int(cast(int, observed[name]["table_bytes"])),
                "indexBytes": int(cast(int, observed[name]["index_bytes"])),
                "rows": int(cast(int, observed[name]["live_tuples"])),
                "deadRows": int(cast(int, observed[name]["dead_tuples"])),
                "partitions": int(cast(int, observed[name]["partitions"])),
                "lastVacuumAt": _iso(
                    observed[name]["last_autovacuum"] or observed[name]["last_vacuum"]
                ),
            }
            for name in relation_names
        ]
        relations.sort(key=lambda row: cast(int, row["totalBytes"]), reverse=True)
        retention = {
            "policyUpdatedAt": _iso(health["updated_at"]),
            "categories": categories,
            "maxLagMs": None if lag_category is None else lag_category["lagMs"],
            "maxLagCategory": None if lag_category is None else lag_category["category"],
            "oldestRetainedAt": None
            if oldest_category is None
            else oldest_category["oldestRetainedAt"],
            "oldestRetainedCategory": None
            if oldest_category is None
            else oldest_category["category"],
            "eligibleHistoryPartitions": {
                "jobEvents": int(cast(int, health["eligible_event_partitions"])),
                "attemptHistory": int(cast(int, health["eligible_attempt_partitions"])),
            },
            "defaultHistoryRows": {
                "jobEvents": int(cast(int, health["default_event_rows"])),
                "attemptHistory": int(cast(int, health["default_attempt_rows"])),
            },
            "defaultHistoryRowsCapped": {
                "jobEvents": health["default_event_rows_capped"],
                "attemptHistory": health["default_attempt_rows_capped"],
            },
        }
        return {
            "capturedAt": _iso(datetime.now(timezone.utc)),
            "window": window,
            "windowSeconds": seconds,
            "status": status,
            "pausedQueues": [cast(str, row["queue"]) for row in queues if row["paused"]],
            "kpis": {
                "drain": {
                    "enqueuedPerMinute": cast(int, summary["enqueued"]) / minutes,
                    "completedPerMinute": cast(int, summary["completed"]) / minutes,
                    "netPerMinute": (
                        cast(int, summary["completed"]) - cast(int, summary["enqueued"])
                    )
                    / minutes,
                },
                "backlog": {
                    "ready": runtime["ready"],
                    "oldestReadyMs": None
                    if runtime["oldest_ready_ms"] is None
                    else str(runtime["oldest_ready_ms"]),
                },
                "errorRate": {
                    "current": 0
                    if not summary["attempts"]
                    else cast(int, summary["errors"]) / cast(int, summary["attempts"]),
                    "previous": 0
                    if not summary["previous_attempts"]
                    else cast(int, summary["previous_errors"])
                    / cast(int, summary["previous_attempts"]),
                    "delta": (
                        0
                        if not summary["attempts"]
                        else cast(int, summary["errors"]) / cast(int, summary["attempts"])
                    )
                    - (
                        0
                        if not summary["previous_attempts"]
                        else cast(int, summary["previous_errors"])
                        / cast(int, summary["previous_attempts"])
                    ),
                },
                "queueWait": {
                    "p50Ms": float(cast(float, wait["p50"])),
                    "p95Ms": float(cast(float, wait["p95"])),
                    "p99Ms": float(cast(float, wait["p99"])),
                },
                "retry": {
                    "backoff": runtime["backoff"],
                    "dueSoon": runtime["due_soon"],
                    "buckets": retries,
                },
                "lease": {
                    "active": runtime["active"],
                    "expired": runtime["expired"],
                    "expiringSoon": runtime["expiring_soon"],
                    "recovered": summary["recovered"],
                },
                "dependencies": dependencies,
                "children": children,
                "externalWaits": external,
                "deadline": {
                    "pending": int(cast(int, health["pending_deadlines"])),
                    "overdue": int(cast(int, health["overdue_deadlines"])),
                    "dueWithinMinute": int(cast(int, health["deadlines_due_within_minute"])),
                    "earliestAt": _iso(health["earliest_deadline_at"]),
                    "activeTimeouts": int(cast(int, health["active_execution_timeouts"])),
                    "overdueTimeouts": int(cast(int, health["overdue_execution_timeouts"])),
                },
            },
            "outcomes": [
                {
                    "bucketStart": _iso(row["bucket_start"]),
                    "enqueued": row["enqueued"],
                    "succeeded": row["succeeded"],
                    "failed": row["failed"],
                    "retry": row["retry"],
                    "leaseExpired": row["lease_expired"],
                    "canceled": row["canceled"],
                }
                for row in outcomes
            ],
            "queues": queues,
            "concurrencyPoliciesCapped": any(
                cast(bool, row["capped"])
                for row in cast(Sequence[Mapping[str, object]], health["concurrency_policies"])
            ),
            "rateLimitPoliciesCapped": any(
                cast(bool, row["policy_set_capped"]) or cast(bool, row["sample_capped"])
                for row in cast(Sequence[Mapping[str, object]], health["rate_limit_policies"])
            ),
            "retryStorm": {
                "buckets": retries,
                "topTypes": [
                    {"queue": row["queue"], "type": row["type"], "count": row["count"]}
                    for row in retry_types
                ],
            },
            "failingTypes": [
                {
                    "queue": row["queue"],
                    "type": row["type"],
                    "attempts": row["attempts"],
                    "errorRate": cast(int, row["errors"]) / cast(int, row["attempts"]),
                    "terminalFailures": row["terminal_failures"],
                    "lastError": row["last_error"],
                    "lastSeenAt": _iso(row["last_seen_at"]),
                }
                for row in failing
            ],
            "integrity": {
                "dueButUnpromoted": runtime["due_but_unpromoted"],
                "partitions": [
                    {
                        "day": row["day"],
                        "startsAt": _iso(row["starts_at"]),
                        "eventExists": row["has_job_events"],
                        "attemptExists": row["has_attempt_history"],
                    }
                    for row in cast(
                        Sequence[Mapping[str, object]], health["history_partition_days"]
                    )
                ],
                "defaultEventRows": int(cast(int, health["default_event_rows"])),
                "defaultAttemptRows": int(cast(int, health["default_attempt_rows"])),
                "retention": retention,
                "storage": {
                    "rollup": {
                        "rolledUpThrough": _iso(health["rolled_up_through"]),
                        "lagMs": float(cast(float, health["rollup_lag_ms"])),
                        "lastRunAt": _iso(health["last_run_at"]),
                        "buckets": int(cast(int, health["buckets"])),
                        "oldestBucketAt": _iso(health["oldest_statistics_at"]),
                        "newestBucketAt": _iso(health["newest_bucket_at"]),
                        "stalled": any(
                            cast(Mapping[str, object], reason).get("code") == "rollup-stalled"
                            for reason in cast(Sequence[object], status["reasons"])
                        ),
                    },
                    "relations": relations,
                    "totalBytes": sum(cast(int, row["totalBytes"]) for row in relations),
                },
            },
        }

    def cron(self, _input: object, _actor: str) -> object:
        return self._json_result(
            "SELECT workhorse.dashboard_cron_v1(%s::jsonb) AS result",
            (json.dumps({"maintenanceLoops": self._maintenance_loops}),),
        )

    def preview_retention_policy(self, input: object, _actor: str) -> object:
        document = cast(Mapping[str, object], input)
        definition = cast(Mapping[str, object], document["definition"])
        current = self._rows("SELECT (policy).* FROM workhorse.get_retention_policy_v1() policy")[0]
        names = (
            "jobIdentityRetentionDays",
            "terminalOutcomeRetentionDays",
            "jobEventRetentionDays",
            "attemptHistoryRetentionDays",
            "scheduleOccurrenceRetentionDays",
            "statisticsRetentionDays",
        )
        columns = tuple(_camel_to_snake(name) for name in names)
        values = [
            definition.get(name, current[column])
            for name, column in zip(names, columns, strict=True)
        ]
        row = self._rows(
            """
            SELECT
              (SELECT count(*)::integer FROM (
                SELECT 1 FROM workhorse.job job
                JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
                WHERE %s::integer IS NOT NULL AND %s::integer IS NOT NULL
                  AND job.created_at < clock_timestamp() - make_interval(days => %s)
                  AND outcome.finished_at < clock_timestamp() - make_interval(days => %s)
                LIMIT 10001
              ) rows) AS terminal_jobs,
              (SELECT count(*)::integer FROM (
                SELECT 1 FROM workhorse.job_event WHERE %s::integer IS NOT NULL
                  AND occurred_at < clock_timestamp() - make_interval(days => %s) LIMIT 10001
              ) rows) AS job_events,
              (SELECT count(*)::integer FROM (
                SELECT 1 FROM workhorse.attempt_history WHERE %s::integer IS NOT NULL
                  AND occurred_at < clock_timestamp() - make_interval(days => %s) LIMIT 10001
              ) rows) AS attempt_history,
              (SELECT count(*)::integer FROM (
                SELECT 1 FROM workhorse.schedule_occurrence WHERE %s::integer IS NOT NULL
                  AND occurrence_at < clock_timestamp() - make_interval(days => %s) LIMIT 10001
              ) rows) AS schedule_occurrences,
              (SELECT count(*)::integer FROM (
                SELECT 1 FROM workhorse.job_stat_bucket WHERE %s::integer IS NOT NULL
                  AND bucket_start < clock_timestamp() - make_interval(days => %s)
                UNION ALL SELECT 1 FROM workhorse.job_stat_bucket_hour WHERE %s::integer IS NOT NULL
                  AND bucket_start < clock_timestamp() - make_interval(days => %s)
                UNION ALL SELECT 1 FROM workhorse.job_stat_bucket_day WHERE %s::integer IS NOT NULL
                  AND bucket_start < clock_timestamp() - make_interval(days => %s) LIMIT 10001
              ) rows) AS statistics
            """,
            (
                values[0],
                values[1],
                values[0],
                values[1],
                values[2],
                values[2],
                values[3],
                values[3],
                values[4],
                values[4],
                values[5],
                values[5],
                values[5],
                values[5],
                values[5],
                values[5],
            ),
        )[0]
        sampled = {
            "terminalJobs": int(cast(int, row["terminal_jobs"])),
            "jobEvents": int(cast(int, row["job_events"])),
            "attemptHistory": int(cast(int, row["attempt_history"])),
            "scheduleOccurrences": int(cast(int, row["schedule_occurrences"])),
            "statistics": int(cast(int, row["statistics"])),
        }
        return {
            "eligible": {name: min(value, 10_000) for name, value in sampled.items()},
            "capped": {name: value > 10_000 for name, value in sampled.items()},
        }

    def set_queue_paused(self, input: object, actor: str) -> object:
        value = cast(Mapping[str, object], input)
        audit = _admin_audit(value, actor)
        if value["paused"]:
            self._admin.pause_queue(cast(str, value["queue"]), audit)
        else:
            self._admin.resume_queue(cast(str, value["queue"]), audit)
        return {"paused": value["paused"]}

    def purge_queue(self, input: object, actor: str) -> object:
        value = cast(Mapping[str, object], input)
        count = self._admin.purge_queue(cast(str, value["queue"]), _admin_audit(value, actor))
        return {"deletedCount": count}

    def set_worker_paused(self, input: object, actor: str) -> object:
        value = cast(Mapping[str, object], input)
        result = self._admin.set_worker_paused(
            cast(str, value["workerId"]),
            cast(bool, value["paused"]),
            _admin_audit(value, actor),
        )
        if result is None:
            raise DashboardRPCError(404, "NOT_FOUND", "Worker not found")
        return {"paused": result.paused}

    def override_maintenance_policy(self, input: object, _actor: str) -> None:
        definition = cast(Mapping[str, object], cast(Mapping[str, object], input)["definition"])
        names = (
            "timezone",
            "partitionPreparationIntervalMs",
            "terminalCleanupIntervalMs",
            "historyRetentionLocalTime",
            "statisticsRollupIntervalMs",
            "statisticsGroupLimit",
            "statisticsRecomputeBuckets",
        )
        self._rows(
            """
            SELECT (policy).* FROM workhorse.override_maintenance_policy_v1(
              %s::text, %s::integer, %s::integer, %s::time,
              %s::integer, %s::integer, %s::integer) policy
            """,
            tuple(definition.get(name) for name in names),
        )

    def revert_maintenance_policy(self, input: object, _actor: str) -> None:
        settings = cast(Sequence[str], cast(Mapping[str, object], input)["settings"])
        self._rows(
            "SELECT (policy).* FROM workhorse.revert_maintenance_policy_v1(%s::text[]) policy",
            ([_camel_to_snake(name) for name in settings],),
        )

    def override_retention_policy(self, input: object, _actor: str) -> None:
        definition = cast(Mapping[str, object], cast(Mapping[str, object], input)["definition"])
        overrides = {_camel_to_snake(name): value for name, value in definition.items()}
        self._rows(
            "SELECT (policy).* FROM workhorse.override_retention_policy_v1(%s::jsonb) policy",
            (json.dumps(overrides),),
        )

    def revert_retention_policy(self, input: object, _actor: str) -> None:
        settings = cast(Sequence[str], cast(Mapping[str, object], input)["settings"])
        self._rows(
            "SELECT (policy).* FROM workhorse.revert_retention_policy_v1(%s::text[]) policy",
            ([_camel_to_snake(name) for name in settings],),
        )

    def run_task_now(self, input: object, _actor: str) -> object:
        job_id = cast(Mapping[str, object], input)["id"]
        row = self._rows(
            "SELECT status, state, run_at FROM workhorse.dashboard_run_task_now_v1(%s::uuid)",
            (job_id,),
        )[0]
        if row["status"] == "not_found":
            raise DashboardRPCError(404, "NOT_FOUND", "Task not found")
        return {
            "status": row["status"],
            "id": str(job_id),
            "state": row["state"],
            "runAt": _iso(row["run_at"]),
        }

    def cancel_task(self, input: object, actor: str) -> object:
        value = cast(Mapping[str, object], input)
        audit = cast(Mapping[str, object], value["audit"])
        row = self._rows(
            """
            SELECT status, state, current_attempt, requested_at, requested_by, reason, finished_at
              FROM workhorse.cancel_v1(%s::uuid, %s::text, %s::text)
            """,
            (value["id"], actor, audit.get("reason")),
        )[0]
        if row["status"] == "not_found":
            raise DashboardRPCError(404, "NOT_FOUND", "Task not found")
        return {
            "status": row["status"],
            "jobId": str(value["id"]),
            "state": row["state"],
            "currentAttempt": row["current_attempt"],
            "requestedAt": _iso(row["requested_at"]),
            "requestedBy": row["requested_by"],
            "reason": row["reason"],
            "finishedAt": _iso(row["finished_at"]),
        }

    def signal_task(self, input: object, actor: str) -> object:
        value = cast(Mapping[str, object], input)
        row = self._rows(
            """
            SELECT status, payload, delivered_at, delivered_by FROM workhorse.send_signal_v1(
              %s::uuid, %s::text, %s::jsonb, %s::text, %s::text)
            """,
            (
                value["id"],
                value["name"],
                json.dumps(value["payload"]),
                value["idempotencyKey"],
                actor,
            ),
        )[0]
        if row["status"] == "not_found":
            raise DashboardRPCError(404, "NOT_FOUND", "Task not found")
        return {
            "status": row["status"],
            "jobId": str(value["id"]),
            "name": value["name"],
            "payload": row["payload"],
            "deliveredAt": _iso(row["delivered_at"]),
            "deliveredBy": row["delivered_by"],
        }

    def complete_human_wait(self, input: object, actor: str) -> object:
        value = cast(Mapping[str, object], input)
        row = self._rows(
            """
            SELECT status, result, completed_at, completed_by
              FROM workhorse.complete_human_wait_v1(
                %s::uuid, %s::text, %s::jsonb, %s::text, %s::text)
            """,
            (
                value["id"],
                value["name"],
                json.dumps(value["result"]),
                value["idempotencyKey"],
                actor,
            ),
        )[0]
        if row["status"] == "not_found":
            raise DashboardRPCError(404, "NOT_FOUND", "Task not found")
        return {
            "status": row["status"],
            "jobId": str(value["id"]),
            "name": value["name"],
            "result": row["result"],
            "completedAt": _iso(row["completed_at"]),
            "completedBy": row["completed_by"],
        }


def _camel_to_snake(value: str) -> str:
    return "".join(
        ("_" + character.lower()) if character.isupper() else character for character in value
    )


def _admin_audit(input: Mapping[str, object], actor: str) -> AdminAudit:
    audit = cast(Mapping[str, object], input["audit"])
    return AdminAudit(
        actor=actor,
        reason=cast(str, audit["reason"]),
        request_id=cast(str, audit["requestId"]),
    )
