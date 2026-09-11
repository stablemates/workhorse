from __future__ import annotations

import json

from protocol_fixtures import assert_fixture_execution, read_protocol_fixture
from test_enqueue import Connection

from workhorse import Queue, ScheduleDefinition, ScheduledTask
from workhorse._statements import MINIMUM_SCHEMA_VERSION


def test_synchronizes_every_shared_schedule_fixture_through_the_versioned_sql_function() -> None:
    fixtures = read_protocol_fixture("schedules.json")
    executed: set[str] = set()
    for fixture in fixtures:
        connection = Connection(
            [
                [
                    {"kind": "schema", "version": MINIMUM_SCHEMA_VERSION},
                    {"kind": "protocol", "version": 1},
                ],
                [],
            ]
        )

        Queue(connection, default_queue=fixture["defaultQueue"]).sync_schedules(
            fixture["namespace"],
            [
                ScheduleDefinition(
                    name=definition["name"],
                    schedule=definition["schedule"],
                    timezone=definition["timezone"],
                    enabled=definition["enabled"],
                    task=ScheduledTask(
                        type=definition["task"]["type"],
                        payload=definition["task"]["payload"],
                        queue=definition["task"].get("queue"),
                        priority=definition["task"]["priority"],
                        concurrency_key=definition["task"].get("concurrencyKey"),
                        max_attempts=definition["task"]["maxAttempts"],
                        retry_policy=definition["task"].get("retryPolicy"),
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
