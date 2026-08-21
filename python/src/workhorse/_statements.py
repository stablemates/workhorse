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
    enqueue_many: DriverStatement
    sync_schedules: DriverStatement
    promote: DriverStatement
    recover_expired: DriverStatement
    claim: DriverStatement
    heartbeat: DriverStatement
    expire_owned: DriverStatement
    acknowledge_cancel: DriverStatement
    complete: DriverStatement
    fail: DriverStatement
    list_checkpoints: DriverStatement
    save_checkpoint: DriverStatement
    list_waits: DriverStatement
    schedule_wait: DriverStatement


STATEMENTS = StatementRegistry(
    compatibility=DriverStatement(
        psycopg="SELECT version FROM workhorse.schema_version ORDER BY version",
        asyncpg="SELECT version FROM workhorse.schema_version ORDER BY version",
    ),
    enqueue_many=DriverStatement(
        psycopg=(
            "SELECT ordinal, job_id, outcome, reason "
            "FROM workhorse.enqueue_many_v2(%s::jsonb) ORDER BY ordinal"
        ),
        asyncpg=(
            "SELECT ordinal, job_id, outcome, reason "
            "FROM workhorse.enqueue_many_v2($1::jsonb) ORDER BY ordinal"
        ),
    ),
    sync_schedules=DriverStatement(
        psycopg=("SELECT workhorse.sync_schedule_definitions_v1(%s::text, %s::jsonb, %s::boolean)"),
        asyncpg=("SELECT workhorse.sync_schedule_definitions_v1($1::text, $2::jsonb, $3::boolean)"),
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
        psycopg="SELECT * FROM workhorse.claim_v3(%s::text, %s::text, %s::integer)",
        asyncpg="SELECT * FROM workhorse.claim_v3($1::text, $2::text, $3::integer)",
    ),
    heartbeat=DriverStatement(
        psycopg=(
            "SELECT workhorse.heartbeat_v2(%s::uuid, %s::text, %s::bigint, %s::integer) AS status"
        ),
        asyncpg=(
            "SELECT workhorse.heartbeat_v2($1::uuid, $2::text, $3::bigint, $4::integer) AS status"
        ),
    ),
    expire_owned=DriverStatement(
        psycopg=("SELECT workhorse.expire_owned_v1(%s::uuid, %s::text, %s::bigint) AS status"),
        asyncpg=("SELECT workhorse.expire_owned_v1($1::uuid, $2::text, $3::bigint) AS status"),
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
)
