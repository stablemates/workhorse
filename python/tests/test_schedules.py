from __future__ import annotations

import json
from typing import Any, cast

import psycopg
import pytest
from protocol_fixtures import assert_fixture_execution, read_protocol_fixture
from test_enqueue import Connection

from workhorse import (
    AsyncQueue,
    Queue,
    ScheduleDefinition,
    ScheduledTask,
    TaskContractValidationError,
    TaskContractVersion,
    TaskTypeContracts,
)
from workhorse._statements import MINIMUM_SCHEMA_VERSION, PROTOCOL_VERSION


def contract_responses(fixture: dict[str, Any]) -> list[list[dict[str, Any]]]:
    """Answer one contract lookup per distinct task type with the row PostgreSQL holds."""
    responses: list[list[dict[str, Any]]] = []
    contracts = fixture.get("contracts", {})
    for task_type in dict.fromkeys(
        definition["task"]["type"] for definition in fixture["application"]
    ):
        if task_type not in contracts:
            responses.append([])
            continue
        version = contracts[task_type]["currentVersion"]
        current = contracts[task_type]["versions"][version]
        responses.append(
            [
                {
                    "version": version,
                    "schema": {
                        "payload": current["payloadSchema"],
                        "result": current["resultSchema"],
                    },
                    "payload_max_bytes": current["maxPayloadBytes"],
                    "result_max_bytes": current["maxResultBytes"],
                    "payload_redact_keys": current["sensitivePayloadKeys"],
                    "result_redact_keys": current["sensitiveResultKeys"],
                }
            ]
        )
    return responses


def test_synchronizes_every_shared_schedule_fixture_through_the_versioned_sql_function() -> None:
    fixtures = read_protocol_fixture("schedules.json")
    executed: set[str] = set()
    for fixture in fixtures:
        lookups = contract_responses(fixture)
        connection = Connection(
            [
                [
                    {"kind": "schema", "version": MINIMUM_SCHEMA_VERSION},
                    {"kind": "protocol", "version": PROTOCOL_VERSION},
                ],
                *lookups,
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
                    catchup_policy=definition["catchupPolicy"],
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

        assert len(connection.calls) == 2 + len(lookups)
        assert all(
            "get_contract_definition_v1" in sql for sql, _ in connection.calls[1 : 1 + len(lookups)]
        )
        sql, parameters = connection.calls[-1]
        assert "workhorse.sync_schedule_definitions_v2" in sql
        assert parameters[0] == fixture["namespace"]
        assert json.loads(cast(str, parameters[1])) == fixture["postgres"]
        assert parameters[2] is fixture["prune"]
        executed.add(fixture["id"])
    assert_fixture_execution("schedules", fixtures, executed)


CAPTURE_CONTRACT = {
    "payment.capture": TaskTypeContracts(
        "v2",
        {
            "v2": TaskContractVersion(
                payload_schema={
                    "type": "object",
                    "required": ["account"],
                    "properties": {"account": {"type": "string"}},
                },
                max_payload_bytes=4096,
                max_result_bytes=8192,
                sensitive_payload_keys=("card",),
                sensitive_result_keys=("receipt",),
            )
        },
    )
}


def capture_schedules(payload: dict[str, Any]) -> list[ScheduleDefinition]:
    return [
        ScheduleDefinition(
            "nightly-capture", "0 2 * * *", ScheduledTask("payment.capture", payload)
        ),
        ScheduleDefinition("nightly-report", "0 3 * * *", ScheduledTask("payment.report", {})),
    ]


def stored_contracts(database_url: str) -> list[tuple[object, ...]]:
    with psycopg.connect(database_url, autocommit=True) as observer:
        return observer.execute(
            "SELECT schedule_name, contract_version, payload_max_bytes, result_max_bytes, "
            "payload_redact_keys, result_redact_keys FROM workhorse.schedule_definition "
            "WHERE namespace = 'billing' ORDER BY schedule_name"
        ).fetchall()


EXPECTED_CONTRACTS = [
    ("nightly-capture", "v2", 4096, 8192, ["card"], ["receipt"]),
    ("nightly-report", None, 1048576, 1048576, [], []),
]


def test_schedule_sync_applies_the_current_contract(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        queue = Queue(connection)
        queue.sync_contracts(CAPTURE_CONTRACT)
        with pytest.raises(TaskContractValidationError) as rejected:
            queue.sync_schedules("billing", capture_schedules({"card": "4242"}))
        assert (rejected.value.version, rejected.value.kind) == ("v2", "payload")
        assert stored_contracts(database_url) == []

        queue.sync_schedules("billing", capture_schedules({"account": "acct_1"}))

    assert stored_contracts(database_url) == EXPECTED_CONTRACTS


async def test_async_schedule_sync_applies_the_current_contract(database_url: str) -> None:
    async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as connection:
        queue = AsyncQueue.from_psycopg(connection)
        await queue.sync_contracts(CAPTURE_CONTRACT)
        with pytest.raises(TaskContractValidationError):
            await queue.sync_schedules("billing", capture_schedules({"card": "4242"}))
        assert stored_contracts(database_url) == []

        await queue.sync_schedules("billing", capture_schedules({"account": "acct_1"}))

    assert stored_contracts(database_url) == EXPECTED_CONTRACTS
