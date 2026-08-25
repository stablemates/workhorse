from __future__ import annotations

import json

from protocol_fixtures import assert_fixture_execution, read_protocol_fixture
from test_enqueue import Connection

from workhorse import Queue, ScheduleDefinition, ScheduledJob


def test_synchronizes_every_shared_schedule_fixture_through_the_versioned_sql_function() -> None:
    fixtures = read_protocol_fixture("schedules.json")
    executed: set[str] = set()
    for fixture in fixtures:
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
        executed.add(fixture["id"])
    assert_fixture_execution("schedules", fixtures, executed)
