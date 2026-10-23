from __future__ import annotations
# ruff: noqa


from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import psycopg

from workhorse import Queue, ScheduleCatchupPolicy, ScheduleDefinition, ScheduledTask, Worker


def _sync_schedule(
    connection: psycopg.Connection[object],
    expression: str,
    schedule_timezone: str = "UTC",
    catchup_policy: ScheduleCatchupPolicy = "skip",
) -> int:
    Queue(connection).sync_schedules(
        "python-worker",
        [
            ScheduleDefinition(
                name="billing-rollup",
                schedule=expression,
                timezone=schedule_timezone,
                catchup_policy=catchup_policy,
                task=ScheduledTask(type="billing.rollup", payload={}),
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


def _occurrences(connection: psycopg.Connection[object]) -> list[datetime]:
    return [
        row[0].astimezone(UTC)
        for row in connection.execute(
            "SELECT occurrence_at FROM workhorse.schedule_occurrence "
            "WHERE namespace = 'python-worker' AND schedule_name = 'billing-rollup' "
            "ORDER BY occurrence_at"
        ).fetchall()
    ]


def _seconds_through_position(
    connection: psycopg.Connection[object], start: datetime
) -> list[datetime]:
    """Each whole second after ``start``, through the durable position after the pass.

    The pass evaluates on the database clock, so a second boundary before the pass adds an
    occurrence of an every-second schedule. A full pass moves the durable position to its pass
    time. A ``skip`` pass also skips each occurrence older than the supported delay, through
    ``last_skipped_through``. Thus this list does not depend on the wall clock. The arithmetic
    uses UTC, so a daylight-saving change in the session time zone has no effect.
    """
    position = connection.execute(
        "SELECT last_evaluated_at, last_skipped_through FROM workhorse.schedule_definition "
        "WHERE namespace = 'python-worker' AND schedule_name = 'billing-rollup'"
    ).fetchone()
    assert position is not None
    evaluated_at = position[0].astimezone(UTC)
    after = start.astimezone(UTC)
    if position[1] is not None:
        after = max(after, position[1].astimezone(UTC))
    first = after.replace(microsecond=0) + timedelta(seconds=1)
    expected: list[datetime] = []
    while first + timedelta(seconds=len(expected)) <= evaluated_at:
        expected.append(first + timedelta(seconds=len(expected)))
    # The old position is 1 second before the pass, so the pass fires at least one occurrence.
    assert expected
    return expected


def test_worker_fires_when_another_worker_owns_the_maintenance_tick(database_url: str) -> None:
    with (
        psycopg.connect(database_url) as definition_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
        psycopg.connect(database_url) as lock_connection,
    ):
        _sync_schedule(definition_connection, "* * * * * *")
        start = worker_connection.execute(
            "UPDATE workhorse.schedule_definition "
            "SET last_evaluated_at = clock_timestamp() - interval '1 second' "
            "RETURNING last_evaluated_at"
        ).fetchone()
        assert start is not None
        lock_connection.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('workhorse:tick', 0))"
        )

        worker = Worker(
            worker_pool,
            worker_id="python-schedule-lock-worker",
            schedule_namespaces=["python-worker"],
        ).handle("billing.rollup", lambda _payload, _context: {"fired": True})

        assert worker.run_once() is True
        assert _occurrences(worker_connection) == _seconds_through_position(
            worker_connection, start[0]
        )


def test_worker_fires_cron_catchup_through_the_configured_limit(database_url: str) -> None:
    with (
        psycopg.connect(database_url) as definition_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        revision = _sync_schedule(definition_connection, "30 */2 * * * *", catchup_policy="all")
        now = datetime.now(UTC).replace(second=30, microsecond=0)
        seed = now - timedelta(minutes=now.minute % 2 + 6)
        seeded = worker_connection.execute(
            "SELECT workhorse.fire_schedule_v1(%s, %s, %s, %s)",
            ("python-worker", "billing-rollup", revision, seed),
        ).fetchone()
        assert seeded is not None and seeded[0] is not None
        worker_connection.execute(
            "UPDATE workhorse.schedule_definition SET last_evaluated_at = %s "
            "WHERE namespace = 'python-worker'",
            (seed,),
        )

        worker = Worker(
            worker_pool,
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


def test_worker_evaluates_cron_in_the_definition_timezone(database_url: str) -> None:
    with (
        psycopg.connect(database_url) as definition_connection,
        psycopg.connect(database_url, autocommit=True) as worker_connection,
    ):
        schedule_timezone = ZoneInfo("America/New_York")
        _sync_schedule(
            definition_connection, "0 0 * * *", schedule_timezone.key, catchup_policy="all"
        )
        local_now = datetime.now(schedule_timezone)
        today = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
        worker_connection.execute(
            "UPDATE workhorse.schedule_definition SET last_evaluated_at = %s "
            "WHERE namespace = 'python-worker'",
            (today - timedelta(days=1),),
        )

        worker = Worker(
            worker_pool,
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
