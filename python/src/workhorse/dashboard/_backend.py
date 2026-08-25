from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
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
        value = self._rows(
            "SELECT workhorse.dashboard_settings_v1(%s::jsonb) AS result",
            (json.dumps({"writable": not self._read_only, "settingsController": True}),),
        )[0]["result"]
        return _iso(json.loads(value) if isinstance(value, str | bytes) else value)

    def system(self, input: object, _actor: str) -> object:
        value = self._rows(
            "SELECT workhorse.dashboard_system_v1(%s::jsonb) AS result",
            (json.dumps(input),),
        )[0]["result"]
        return _iso(json.loads(value) if isinstance(value, str | bytes) else value)

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
