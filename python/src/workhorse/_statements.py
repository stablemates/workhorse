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
)
