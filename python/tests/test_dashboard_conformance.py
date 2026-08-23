from __future__ import annotations

import io
import json
from collections.abc import Iterable
from typing import Any, cast

import psycopg
import pytest
from psycopg.rows import dict_row
from test_protocol_conformance import assert_value, execute_step, read_json, resolve

from workhorse.client import Queue
from workhorse.dashboard import DashboardHost, DashboardPrincipal
from workhorse.types import EnqueueOptions

pytestmark = pytest.mark.integration


def test_python_dashboard_read_procedures_match_the_shared_contract(database_url: str) -> None:
    fixture = read_json("dashboard/v1/conformance.json")
    harness = fixture["harness"]
    references: dict[str, Any] = {}
    with psycopg.connect(database_url, row_factory=dict_row, autocommit=True) as connection:
        for step in fixture["scenarios"][0]["seed"]:
            execute_step(connection, "seed", step, references)
        with psycopg.connect(database_url, autocommit=True) as dashboard_connection:

            def set_schedule_enabled(input: object, _actor: str) -> object:
                value = cast(dict[str, object], input)
                with dashboard_connection.cursor() as cursor:
                    cursor.execute(
                        """UPDATE workhorse.schedule_definition
                              SET enabled=%s,revision=revision+1,updated_at=clock_timestamp()
                            WHERE namespace=%s AND schedule_name=%s RETURNING enabled""",
                        (value["enabled"], value["namespace"], value["name"]),
                    )
                    row = cursor.fetchone()
                assert row is not None
                return {"enabled": row[0]}

            host = DashboardHost(
                dashboard_connection,
                authorize=lambda _: DashboardPrincipal(harness["authenticatedActor"]),
                path=harness["basePath"],
                environment=harness["environment"],
                configured_workers=tuple(harness["configuredWorkers"]),
                maintenance_loops=harness["maintenanceLoops"],
                enqueue_test=lambda input, _actor: {
                    "jobId": Queue(dashboard_connection, default_queue="conformance-demo").enqueue(
                        f"conformance.demo-{cast(dict[str, object], input)['kind']}",
                        {},
                        EnqueueOptions(
                            priority=cast(int, cast(dict[str, object], input).get("priority", 0))
                        ),
                    )
                },
                set_schedule_enabled=set_schedule_enabled,
            )
            read_only_host = DashboardHost(
                dashboard_connection,
                authorize=lambda _: DashboardPrincipal(harness["authenticatedActor"]),
                path=harness["basePath"],
                environment=harness["environment"],
                configured_workers=tuple(harness["configuredWorkers"]),
                maintenance_loops=harness["maintenanceLoops"],
                read_only=True,
            )
            exchanges = fixture["scenarios"][1]["exchanges"]
            for exchange in exchanges:
                status, body = request(host, harness["origin"], exchange, references)
                assert status == exchange["expect"]["status"], (exchange["id"], body)
                assert_value(exchange["expect"]["body"], body, references, exchange["id"])
            for scenario in fixture["scenarios"][2:]:
                for exchange in scenario["exchanges"]:
                    selected = read_only_host if exchange.get("mode") == "read-only" else host
                    status, body = request(selected, harness["origin"], exchange, references)
                    assert status == exchange["expect"]["status"], (exchange["id"], body)
                    assert_value(exchange["expect"]["body"], body, references, exchange["id"])

            connection.execute(
                """INSERT INTO workhorse.concurrency_policy(
                       queue_name,namespace,max_active,max_active_per_key)
                     VALUES ('conformance-demo','dashboard-test',7,2)
                     ON CONFLICT(queue_name) DO UPDATE SET namespace=excluded.namespace,
                       max_active=excluded.max_active,max_active_per_key=excluded.max_active_per_key"""
            )
            connection.execute(
                """INSERT INTO workhorse.rate_limit_policy(
                       queue_name,namespace,rate_limit,rate_interval_ms,rate_burst,
                       per_key_limit,per_key_interval_ms,per_key_burst)
                     VALUES ('conformance-demo','dashboard-test',10,1000,12,3,2000,4)
                     ON CONFLICT(queue_name) DO UPDATE SET namespace=excluded.namespace,
                       rate_limit=excluded.rate_limit,rate_interval_ms=excluded.rate_interval_ms,
                       rate_burst=excluded.rate_burst,per_key_limit=excluded.per_key_limit,
                       per_key_interval_ms=excluded.per_key_interval_ms,
                       per_key_burst=excluded.per_key_burst"""
            )
            connection.execute(
                """INSERT INTO workhorse.rate_limit_bucket(
                       queue_name,bucket_scope,bucket_key,tokens,refilled_at)
                     VALUES ('conformance-demo','queue','',0.5,clock_timestamp()+interval '1 hour')
                     ON CONFLICT(queue_name,bucket_scope,bucket_key) DO UPDATE
                       SET tokens=excluded.tokens,refilled_at=excluded.refilled_at"""
            )
            job = connection.execute(
                """SELECT job.id,runtime.current_attempt FROM workhorse.dashboard_job_v1 job
                     JOIN workhorse.dashboard_job_runtime_v1 runtime ON runtime.job_id=job.id
                    WHERE job.queue_name='conformance-demo' ORDER BY job.created_at LIMIT 1"""
            ).fetchone()
            assert job is not None
            connection.execute(
                """INSERT INTO workhorse.job_event(job_id,attempt,event_type,details)
                     VALUES (%s,%s,'batch_dispatched',jsonb_build_object(
                       'batch_id','dashboard-semantic-batch','members',jsonb_build_array(
                         jsonb_build_object('job_id',%s::uuid,'attempt',%s))))""",
                (job["id"], job["current_attempt"], job["id"], job["current_attempt"]),
            )

            _, queues_body = request(
                host,
                harness["origin"],
                {"procedure": "queues", "request": {"json": None}},
                references,
            )
            queue = next(
                row for row in queues_body["json"]["queues"] if row["queue"] == "conformance-demo"
            )
            assert queue["concurrencyPolicy"]["maxActive"] == 7
            assert queue["concurrencyPolicy"]["maxActivePerKey"] == 2
            assert queue["rateLimitPolicy"]["rate"] == {
                "limit": 10,
                "intervalMs": 1000,
                "burst": 12,
            }
            assert queue["rateLimitPolicy"]["availableTokens"] == 0.5

            _, detail_body = request(
                host,
                harness["origin"],
                {"procedure": "jobDetail", "request": {"json": {"id": str(job["id"])}}},
                references,
            )
            detail = detail_body["json"]
            assert detail["concurrencyPolicy"]["maxActive"] == 7
            assert detail["batchExecutions"][0]["id"] == "dashboard-semantic-batch"

            connection.execute(
                """WITH job AS (
                       INSERT INTO workhorse.job(queue_name,job_type,payload,max_attempts)
                       VALUES ('conformance-demo','conformance.retry-summary','{}',3) RETURNING id
                     ) INSERT INTO workhorse.job_runtime(
                       job_id,queue_name,state,current_attempt,run_at)
                     SELECT id,'conformance-demo','scheduled',2,
                       clock_timestamp()+interval '30 seconds' FROM job"""
            )
            system_status, system_body = request(
                host,
                harness["origin"],
                {"procedure": "system", "request": {"json": {"window": "1h"}}},
                references,
            )
            assert system_status == 200, system_body
            system = system_body["json"]
            assert system["retryStorm"]["buckets"][0]["count"] >= 1
            assert system["retryStorm"]["topTypes"][0]["count"] >= 1


def request(
    host: DashboardHost,
    origin: str,
    exchange: dict[str, Any],
    references: dict[str, Any],
) -> tuple[int, Any]:
    payload = json.dumps(resolve(exchange["request"], references)).encode()
    origin_mode = exchange.get("origin", "same")
    request_origin = origin if origin_mode == "same" else "http://attacker.conformance.test"
    environ: dict[str, object] = {
        "REQUEST_METHOD": exchange.get("method", "POST"),
        "PATH_INFO": f"/workhorse/rpc/dashboard/{exchange['procedure']}",
        "wsgi.url_scheme": "http",
        "HTTP_HOST": origin.removeprefix("http://"),
        "CONTENT_LENGTH": str(len(payload)),
        "CONTENT_TYPE": "application/json",
        "wsgi.input": io.BytesIO(payload),
    }
    if origin_mode != "none":
        environ["HTTP_ORIGIN"] = request_origin
    captured: dict[str, object] = {}

    def start_response(status: str, _headers: list[tuple[str, str]]) -> None:
        captured["status"] = int(status.split()[0])

    response = b"".join(cast(Iterable[bytes], host(environ, start_response)))
    return cast(int, captured["status"]), json.loads(response)
