from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

DriverDialect = Literal["psycopg", "asyncpg"]


@dataclass(frozen=True)
class DriverStatement:
    psycopg: str
    asyncpg: str

    def for_dialect(self, dialect: DriverDialect) -> str:
        if dialect == "psycopg":
            return self.psycopg
        return self.asyncpg


@dataclass(frozen=True)
class StatementRegistry:
    compatibility: DriverStatement
    health: DriverStatement
    enqueue_many: DriverStatement
    sync_schedules: DriverStatement
    tick: DriverStatement
    run_maintenance: DriverStatement
    register_worker: DriverStatement
    deregister_worker: DriverStatement
    list_schedules: DriverStatement
    fire_schedule: DriverStatement
    promote: DriverStatement
    recover_expired: DriverStatement
    claim: DriverStatement
    record_batch_dispatch: DriverStatement
    record_batch_failure: DriverStatement
    heartbeat: DriverStatement
    expire_owned: DriverStatement
    acknowledge_cancel: DriverStatement
    complete: DriverStatement
    fail: DriverStatement
    list_checkpoints: DriverStatement
    save_checkpoint: DriverStatement
    list_waits: DriverStatement
    schedule_wait: DriverStatement
    wait_for_signal: DriverStatement
    send_signal: DriverStatement
    wait_for_human: DriverStatement
    complete_human_wait: DriverStatement
    create_child: DriverStatement
    create_children: DriverStatement


STATEMENTS = StatementRegistry(
    compatibility=DriverStatement(
        psycopg="SELECT version FROM workhorse.schema_version ORDER BY version",
        asyncpg="SELECT version FROM workhorse.schema_version ORDER BY version",
    ),
    health=DriverStatement(
        psycopg="SELECT workhorse.queue_health_v1(%s::timestamptz) AS snapshot",
        asyncpg="SELECT workhorse.queue_health_v1($1::timestamptz) AS snapshot",
    ),
    enqueue_many=DriverStatement(
        psycopg=(
            "SELECT ordinal, job_id, outcome, reason "
            "FROM workhorse.enqueue_many_v1(%s::jsonb) ORDER BY ordinal"
        ),
        asyncpg=(
            "SELECT ordinal, job_id, outcome, reason "
            "FROM workhorse.enqueue_many_v1($1::jsonb) ORDER BY ordinal"
        ),
    ),
    sync_schedules=DriverStatement(
        psycopg=("SELECT workhorse.sync_schedule_definitions_v1(%s::text, %s::jsonb, %s::boolean)"),
        asyncpg=("SELECT workhorse.sync_schedule_definitions_v1($1::text, $2::jsonb, $3::boolean)"),
    ),
    tick=DriverStatement(
        psycopg="SELECT * FROM workhorse.tick_v1(%s::integer, %s::integer)",
        asyncpg="SELECT * FROM workhorse.tick_v1($1::integer, $2::integer)",
    ),
    run_maintenance=DriverStatement(
        psycopg="SELECT * FROM workhorse.run_maintenance_v1(%s::timestamptz)",
        asyncpg="SELECT * FROM workhorse.run_maintenance_v1($1::timestamptz)",
    ),
    register_worker=DriverStatement(
        psycopg=(
            "SELECT workhorse.register_worker_v1(%s::text, %s::uuid, %s::text, %s::integer, "
            "%s::text[], %s::integer, %s::integer, %s::integer, %s::integer, %s::integer, "
            "%s::integer, %s::integer, %s::integer, %s::boolean) AS paused"
        ),
        asyncpg=(
            "SELECT workhorse.register_worker_v1($1::text, $2::uuid, $3::text, $4::integer, "
            "$5::text[], $6::integer, $7::integer, $8::integer, $9::integer, $10::integer, "
            "$11::integer, $12::integer, $13::integer, $14::boolean) AS paused"
        ),
    ),
    deregister_worker=DriverStatement(
        psycopg="SELECT workhorse.deregister_worker_v1(%s::text) AS deregistered",
        asyncpg="SELECT workhorse.deregister_worker_v1($1::text) AS deregistered",
    ),
    list_schedules=DriverStatement(
        psycopg=(
            "SELECT definition.namespace, definition.schedule_name, "
            "definition.cron_expression, definition.revision::text, "
            "max(occurrence.occurrence_at) AS last_occurrence_at "
            "FROM workhorse.schedule_definition definition "
            "LEFT JOIN workhorse.schedule_occurrence occurrence "
            "ON occurrence.namespace = definition.namespace "
            "AND occurrence.schedule_name = definition.schedule_name "
            "WHERE definition.enabled AND definition.namespace = ANY(%s::text[]) "
            "GROUP BY definition.namespace, definition.schedule_name "
            "ORDER BY definition.namespace, definition.schedule_name"
        ),
        asyncpg=(
            "SELECT definition.namespace, definition.schedule_name, "
            "definition.cron_expression, definition.revision::text, "
            "max(occurrence.occurrence_at) AS last_occurrence_at "
            "FROM workhorse.schedule_definition definition "
            "LEFT JOIN workhorse.schedule_occurrence occurrence "
            "ON occurrence.namespace = definition.namespace "
            "AND occurrence.schedule_name = definition.schedule_name "
            "WHERE definition.enabled AND definition.namespace = ANY($1::text[]) "
            "GROUP BY definition.namespace, definition.schedule_name "
            "ORDER BY definition.namespace, definition.schedule_name"
        ),
    ),
    fire_schedule=DriverStatement(
        psycopg=(
            "SELECT workhorse.fire_schedule_v1(%s::text, %s::text, %s::bigint, "
            "%s::timestamptz) AS job_id"
        ),
        asyncpg=(
            "SELECT workhorse.fire_schedule_v1($1::text, $2::text, $3::bigint, "
            "$4::timestamptz) AS job_id"
        ),
    ),
    promote=DriverStatement(
        psycopg="SELECT workhorse.promote_v1(%s::integer) AS promoted",
        asyncpg="SELECT workhorse.promote_v1($1::integer) AS promoted",
    ),
    recover_expired=DriverStatement(
        psycopg=("SELECT * FROM workhorse.recover_expired_telemetry_v1(%s::integer, %s::integer)"),
        asyncpg=("SELECT * FROM workhorse.recover_expired_telemetry_v1($1::integer, $2::integer)"),
    ),
    claim=DriverStatement(
        psycopg="SELECT * FROM workhorse.claim_v1(%s::text, %s::text, %s::integer)",
        asyncpg="SELECT * FROM workhorse.claim_v1($1::text, $2::text, $3::integer)",
    ),
    record_batch_dispatch=DriverStatement(
        psycopg=(
            "SELECT workhorse.record_batch_dispatch_v1(%s::uuid, %s::uuid[], %s::integer[], "
            "%s::bigint[], %s::text) AS recorded"
        ),
        asyncpg=(
            "SELECT workhorse.record_batch_dispatch_v1($1::uuid, $2::uuid[], $3::integer[], "
            "$4::bigint[], $5::text) AS recorded"
        ),
    ),
    record_batch_failure=DriverStatement(
        psycopg=(
            "SELECT workhorse.record_batch_failure_v1(%s::uuid, %s::uuid[], %s::integer[], "
            "%s::bigint[], %s::text) AS recorded"
        ),
        asyncpg=(
            "SELECT workhorse.record_batch_failure_v1($1::uuid, $2::uuid[], $3::integer[], "
            "$4::bigint[], $5::text) AS recorded"
        ),
    ),
    heartbeat=DriverStatement(
        psycopg=(
            "SELECT workhorse.heartbeat_v1(%s::uuid, %s::text, %s::bigint, %s::integer) AS status"
        ),
        asyncpg=(
            "SELECT workhorse.heartbeat_v1($1::uuid, $2::text, $3::bigint, $4::integer) AS status"
        ),
    ),
    expire_owned=DriverStatement(
        psycopg=(
            "SELECT * FROM workhorse.expire_owned_telemetry_v1(%s::uuid, %s::text, %s::bigint)"
        ),
        asyncpg=(
            "SELECT * FROM workhorse.expire_owned_telemetry_v1($1::uuid, $2::text, $3::bigint)"
        ),
    ),
    acknowledge_cancel=DriverStatement(
        psycopg=(
            "SELECT workhorse.acknowledge_cancel_v1(%s::uuid, %s::text, %s::bigint) AS accepted"
        ),
        asyncpg=(
            "SELECT workhorse.acknowledge_cancel_v1($1::uuid, $2::text, $3::bigint) AS accepted"
        ),
    ),
    complete=DriverStatement(
        psycopg=(
            "SELECT workhorse.complete_v1(%s::uuid, %s::text, %s::bigint, %s::jsonb) AS accepted"
        ),
        asyncpg=(
            "SELECT workhorse.complete_v1($1::uuid, $2::text, $3::bigint, $4::jsonb) AS accepted"
        ),
    ),
    fail=DriverStatement(
        psycopg=(
            "SELECT workhorse.fail_v1(%s::uuid, %s::text, %s::bigint, %s::jsonb, "
            "%s::integer) AS state"
        ),
        asyncpg=(
            "SELECT workhorse.fail_v1($1::uuid, $2::text, $3::bigint, $4::jsonb, "
            "$5::integer) AS state"
        ),
    ),
    list_checkpoints=DriverStatement(
        psycopg=(
            "SELECT checkpoint_name, checkpoint_value, attempt, fence_token::text, "
            "worker_id, created_at FROM workhorse.job_checkpoint "
            "WHERE job_id = %s::uuid ORDER BY created_at, checkpoint_name"
        ),
        asyncpg=(
            "SELECT checkpoint_name, checkpoint_value, attempt, fence_token::text, "
            "worker_id, created_at FROM workhorse.job_checkpoint "
            "WHERE job_id = $1::uuid ORDER BY created_at, checkpoint_name"
        ),
    ),
    save_checkpoint=DriverStatement(
        psycopg=(
            "SELECT status, checkpoint_value, attempt, fence_token::text, worker_id, created_at "
            "FROM workhorse.save_checkpoint_v1(%s::uuid, %s::text, %s::bigint, %s::text, %s::jsonb)"
        ),
        asyncpg=(
            "SELECT status, checkpoint_value, attempt, fence_token::text, worker_id, created_at "
            "FROM workhorse.save_checkpoint_v1($1::uuid, $2::text, $3::bigint, $4::text, $5::jsonb)"
        ),
    ),
    list_waits=DriverStatement(
        psycopg=(
            "SELECT wait_name, mode, duration_ms::text, requested_wake_at, wake_at, attempt, "
            "fence_token::text, worker_id, created_at FROM workhorse.job_wait "
            "WHERE job_id = %s::uuid ORDER BY created_at, wait_name"
        ),
        asyncpg=(
            "SELECT wait_name, mode, duration_ms::text, requested_wake_at, wake_at, attempt, "
            "fence_token::text, worker_id, created_at FROM workhorse.job_wait "
            "WHERE job_id = $1::uuid ORDER BY created_at, wait_name"
        ),
    ),
    schedule_wait=DriverStatement(
        psycopg=(
            "SELECT status, wait_name, mode, duration_ms::text, requested_wake_at, wake_at, "
            "attempt, fence_token::text, worker_id, created_at "
            "FROM workhorse.schedule_wait_v1(%s::uuid, %s::text, %s::bigint, %s::text, "
            "%s::bigint, %s::timestamptz)"
        ),
        asyncpg=(
            "SELECT status, wait_name, mode, duration_ms::text, requested_wake_at, wake_at, "
            "attempt, fence_token::text, worker_id, created_at "
            "FROM workhorse.schedule_wait_v1($1::uuid, $2::text, $3::bigint, $4::text, "
            "$5::bigint, $6::timestamptz)"
        ),
    ),
    wait_for_signal=DriverStatement(
        psycopg=(
            "SELECT status, payload FROM workhorse.wait_for_signal_v1("
            "%s::uuid, %s::text, %s::bigint, %s::text, %s::bigint)"
        ),
        asyncpg=(
            "SELECT status, payload FROM workhorse.wait_for_signal_v1("
            "$1::uuid, $2::text, $3::bigint, $4::text, $5::bigint)"
        ),
    ),
    send_signal=DriverStatement(
        psycopg=(
            "SELECT status, payload, delivered_at, delivered_by FROM workhorse.send_signal_v1("
            "%s::uuid, %s::text, %s::jsonb, %s::text, %s::text)"
        ),
        asyncpg=(
            "SELECT status, payload, delivered_at, delivered_by FROM workhorse.send_signal_v1("
            "$1::uuid, $2::text, $3::jsonb, $4::text, $5::text)"
        ),
    ),
    wait_for_human=DriverStatement(
        psycopg=(
            "SELECT status, result FROM workhorse.wait_for_human_v1("
            "%s::uuid, %s::text, %s::bigint, %s::text, %s::jsonb, %s::bigint)"
        ),
        asyncpg=(
            "SELECT status, result FROM workhorse.wait_for_human_v1("
            "$1::uuid, $2::text, $3::bigint, $4::text, $5::jsonb, $6::bigint)"
        ),
    ),
    complete_human_wait=DriverStatement(
        psycopg=(
            "SELECT status, result, completed_at, completed_by "
            "FROM workhorse.complete_human_wait_v1("
            "%s::uuid, %s::text, %s::jsonb, %s::text, %s::text)"
        ),
        asyncpg=(
            "SELECT status, result, completed_at, completed_by "
            "FROM workhorse.complete_human_wait_v1("
            "$1::uuid, $2::text, $3::jsonb, $4::text, $5::text)"
        ),
    ),
    create_child=DriverStatement(
        psycopg=(
            "SELECT status, child_job_id, child_type, created_at, joined_at, result "
            "FROM workhorse.create_child_v1(%s::uuid, %s::text, %s::bigint, %s::text, %s::jsonb)"
        ),
        asyncpg=(
            "SELECT status, child_job_id, child_type, created_at, joined_at, result "
            "FROM workhorse.create_child_v1($1::uuid, $2::text, $3::bigint, $4::text, $5::jsonb)"
        ),
    ),
    create_children=DriverStatement(
        psycopg=(
            "SELECT status, children, results, result_bytes, result_limit_bytes "
            "FROM workhorse.create_children_v1(%s::uuid, %s::text, %s::bigint, %s::jsonb)"
        ),
        asyncpg=(
            "SELECT status, children, results, result_bytes, result_limit_bytes "
            "FROM workhorse.create_children_v1($1::uuid, $2::text, $3::bigint, $4::jsonb)"
        ),
    ),
)
