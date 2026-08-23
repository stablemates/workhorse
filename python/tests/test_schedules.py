from __future__ import annotations

import json
from pathlib import Path

from test_enqueue import Connection

from workhorse import Queue, ScheduleDefinition, ScheduledJob

REPOSITORY = Path(__file__).parents[2]


def test_synchronizes_recurring_definitions_through_the_versioned_sql_function() -> None:
    fixture = json.loads((REPOSITORY / "protocol/v1/schedules.json").read_text())[0]
    connection = Connection([[{"version": 1}], []])

    Queue(connection, default_queue=fixture["defaultQueue"]).sync_schedules(
        fixture["namespace"],
        [
            ScheduleDefinition(
                name=definition["name"],
                schedule=definition["schedule"],
                timezone=definition["timezone"],
                enabled=definition["enabled"],
                job=ScheduledJob(
                    type=definition["job"]["type"],
                    payload=definition["job"]["payload"],
                    queue=definition["job"].get("queue"),
                    priority=definition["job"]["priority"],
                    concurrency_key=definition["job"].get("concurrencyKey"),
                    max_attempts=definition["job"]["maxAttempts"],
                    retry_policy=definition["job"].get("retryPolicy"),
                ),
            )
            for definition in fixture["application"]
        ],
        prune=fixture["prune"],
    )

    assert "workhorse.sync_schedule_definitions_v1" in connection.calls[1][0]
    assert connection.calls[1][1][0] == fixture["namespace"]
    assert json.loads(connection.calls[1][1][1]) == fixture["postgres"]
    assert connection.calls[1][1][2] is fixture["prune"]
