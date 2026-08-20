from __future__ import annotations

import json

from test_enqueue import Connection

from workhorse import Queue, ScheduleDefinition, ScheduledJob


def test_synchronizes_recurring_definitions_through_the_versioned_sql_function() -> None:
    connection = Connection([[{"version": 47}], []])

    Queue(connection, default_queue="mail").sync_schedules(
        "billing",
        [
            ScheduleDefinition(
                name="monthly-invoice",
                schedule="0 0 1 * *",
                job=ScheduledJob(
                    type="invoice.create",
                    payload={"account": "acct-1"},
                    priority=80,
                ),
            )
        ],
    )

    assert "workhorse.sync_schedule_definitions_v1" in connection.calls[1][0]
    assert connection.calls[1][1][0] == "billing"
    assert json.loads(connection.calls[1][1][1]) == [
        {
            "name": "monthly-invoice",
            "schedule": "0 0 1 * *",
            "enabled": True,
            "queue": "mail",
            "priority": 80,
            "concurrencyKey": None,
            "type": "invoice.create",
            "payload": {"account": "acct-1"},
            "maxAttempts": 25,
            "retryPolicy": None,
            "contractVersion": None,
            "payloadMaxBytes": 1_048_576,
            "resultMaxBytes": 1_048_576,
            "sensitivePayloadKeys": [],
            "sensitiveResultKeys": [],
        }
    ]
    assert connection.calls[1][1][2] is True
