from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import psycopg
from dateutil.tz import gettz

from workhorse import Queue, ScheduleDefinition, ScheduledJob, Worker
from workhorse.worker import _due_occurrences


def _sync_schedule(connection: psycopg.Connection[object], expression: str) -> int:
    Queue(connection).sync_schedules(
        "python-worker",
        [
            ScheduleDefinition(
                name="billing-rollup",
                schedule=expression,
                job=ScheduledJob(type="billing.rollup", payload={}),
            )
        ],
    )
    connection.commit()
    revision = connection.execute(
        "SELECT revision FROM workhorse.schedule_definition "
        "WHERE namespace = 'python-worker' AND schedule_name = 'billing-rollup'"
    ).fetchone()
    assert revision is not None
    return int(revision[0])


def test_worker_fires_only_when_it_owns_the_maintenance_tick(database_url: str) -> None:
    with (
        psycopg.connect(database_url) as definition_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
        psycopg.connect(database_url) as lock_connection,
    ):
        _sync_schedule(definition_connection, "* * * * *")
        lock_connection.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('workhorse:tick', 0))"
        )

        worker = Worker(
            worker_connection,
            worker_id="python-schedule-lock-worker",
            schedule_namespaces=["python-worker"],
        ).handle("billing.rollup", lambda _payload, _context: {"fired": True})

        assert worker.run_once() is False
        assert worker_connection.execute(
            "SELECT count(*) FROM workhorse.schedule_occurrence"
        ).fetchone() == (0,)


def test_worker_fires_cron_catchup_through_the_configured_limit(database_url: str) -> None:
    with (
        psycopg.connect(database_url) as definition_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        revision = _sync_schedule(definition_connection, "30 */2 * * * *")
        now = datetime.now(timezone.utc).replace(second=30, microsecond=0)
        seed = now - timedelta(minutes=now.minute % 2 + 6)
        seeded = worker_connection.execute(
            "SELECT workhorse.fire_schedule_v1(%s, %s, %s, %s)",
            ("python-worker", "billing-rollup", revision, seed),
        ).fetchone()
        assert seeded is not None and seeded[0] is not None

        worker = Worker(
            worker_connection,
            worker_id="python-schedule-catchup-worker",
            schedule_namespaces=["python-worker"],
            schedule_catchup_limit=2,
        ).handle("billing.rollup", lambda _payload, _context: {"fired": True})

        assert worker.run_once() is True
        occurrences = worker_connection.execute(
            "SELECT occurrence_at FROM workhorse.schedule_occurrence "
            "WHERE namespace = 'python-worker' AND schedule_name = 'billing-rollup' "
            "ORDER BY occurrence_at"
        ).fetchall()
        assert occurrences == [
            (seed,),
            (seed + timedelta(minutes=2),),
            (seed + timedelta(minutes=4),),
        ]


def test_worker_evaluates_cron_in_the_process_timezone(database_url: str) -> None:
    with (
        psycopg.connect(database_url) as definition_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        _sync_schedule(definition_connection, "0 0 * * *")
        local_now = datetime.now().astimezone()
        today = local_now.replace(hour=0, minute=0, second=0, microsecond=0)

        worker = Worker(
            worker_connection,
            worker_id="python-schedule-timezone-worker",
            schedule_namespaces=["python-worker"],
            schedule_catchup_limit=1,
        ).handle("billing.rollup", lambda _payload, _context: {"fired": True})

        assert worker.run_once() is True
        occurrences = worker_connection.execute(
            "SELECT occurrence_at FROM workhorse.schedule_occurrence "
            "WHERE namespace = 'python-worker' AND schedule_name = 'billing-rollup' "
            "ORDER BY occurrence_at"
        ).fetchall()
        assert occurrences == [(today,)]


def test_cron_occurrences_match_process_timezone_dst_semantics() -> None:
    eastern = gettz("America/New_York")
    assert eastern is not None

    with patch("workhorse.worker.tzlocal", return_value=eastern):
        spring = _due_occurrences(
            "30 2 * * *",
            datetime(2026, 3, 7, 7, 30, tzinfo=timezone.utc),
            datetime(2026, 3, 8, 8, 0, tzinfo=timezone.utc),
            10,
        )
        fall = _due_occurrences(
            "30 1 * * *",
            datetime(2026, 10, 31, 5, 30, tzinfo=timezone.utc),
            datetime(2026, 11, 1, 7, 0, tzinfo=timezone.utc),
            10,
        )

    assert [occurrence.astimezone(timezone.utc) for occurrence in spring] == [
        datetime(2026, 3, 8, 7, 30, tzinfo=timezone.utc)
    ]
    assert [occurrence.astimezone(timezone.utc) for occurrence in fall] == [
        datetime(2026, 11, 1, 5, 30, tzinfo=timezone.utc)
    ]


def test_hashed_cron_fields_use_the_cross_runtime_offset() -> None:
    with patch("workhorse.worker.tzlocal", return_value=timezone.utc):
        occurrences = _due_occurrences(
            "H * * * *",
            datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 1, 1, 1, 0, tzinfo=timezone.utc),
            10,
        )

    assert occurrences == [datetime(2026, 1, 1, 0, 44, tzinfo=timezone.utc)]


def test_hashed_field_expansion_preserves_named_weekdays() -> None:
    with patch("workhorse.worker.tzlocal", return_value=timezone.utc):
        occurrences = _due_occurrences(
            "0 0 * * THU",
            datetime(2026, 1, 7, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 1, 8, 0, 0, tzinfo=timezone.utc),
            10,
        )

    assert occurrences == [datetime(2026, 1, 8, 0, 0, tzinfo=timezone.utc)]
