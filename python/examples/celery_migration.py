from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast
from urllib.parse import urlsplit, urlunsplit
from uuid import NAMESPACE_URL, uuid4, uuid5

import psycopg
from celery import Celery  # type: ignore[import-untyped]
from psycopg.pq import TransactionStatus
from psycopg_pool import ConnectionPool

from workhorse import EnqueueOptions, HandlerContext, Idempotency, Json, Queue, Worker

TASK_TYPE = "migration.credit"
QUEUE = "celery-migration"
Destination = Literal["celery", "workhorse"]

APPLICATION_SCHEMA = """
CREATE SCHEMA celery_migration;
CREATE TABLE celery_migration.route (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    destination text NOT NULL CHECK (destination IN ('celery', 'workhorse'))
);
INSERT INTO celery_migration.route (destination) VALUES ('celery');
CREATE TABLE celery_migration.account (
    account_id text PRIMARY KEY,
    credit_cents bigint NOT NULL DEFAULT 0
);
CREATE TABLE celery_migration.operation (
    operation_id text PRIMARY KEY,
    account_id text NOT NULL REFERENCES celery_migration.account,
    amount_cents bigint NOT NULL CHECK (amount_cents > 0),
    original_destination text NOT NULL CHECK (original_destination IN ('celery', 'workhorse')),
    workhorse_task_id uuid
);
CREATE TABLE celery_migration.effect (
    operation_id text PRIMARY KEY REFERENCES celery_migration.operation,
    applied_at timestamptz NOT NULL DEFAULT now()
);
"""


@dataclass(frozen=True)
class StagedOperation:
    destination: Destination
    task_id: str | None


def credit_payload(account_id: str, payment_reference: str, amount_cents: int) -> dict[str, Json]:
    if not payment_reference:
        raise ValueError("An immutable payment reference is required")
    identity = json.dumps(["credit-v1", account_id, payment_reference], separators=(",", ":"))
    payload: dict[str, Json] = {
        "operation_id": str(uuid5(NAMESPACE_URL, identity)),
        "account_id": account_id,
        "amount_cents": amount_cents,
    }
    validate_payload(payload)
    return payload


def validate_payload(payload: object) -> tuple[str, str, int]:
    if not isinstance(payload, dict) or set(payload) != {
        "operation_id",
        "account_id",
        "amount_cents",
    }:
        raise ValueError("Expected exactly operation_id, account_id, and amount_cents")
    operation_id, account_id, amount_cents = (
        payload["operation_id"],
        payload["account_id"],
        payload["amount_cents"],
    )
    if not isinstance(operation_id, str) or not operation_id or len(operation_id) > 200:
        raise ValueError("operation_id must be a nonempty retained business identity")
    if not isinstance(account_id, str) or not account_id or len(account_id) > 200:
        raise ValueError("account_id must be a nonempty account identity")
    if type(amount_cents) is not int or not 0 < amount_cents <= 2**63 - 1:
        raise ValueError("amount_cents must be a positive bigint")
    return operation_id, account_id, amount_cents


def require_transaction(connection: psycopg.Connection[Any]) -> None:
    if connection.info.transaction_status != TransactionStatus.INTRANS:
        raise ValueError("The caller must enter connection.transaction() first")


def stage_operation(
    connection: psycopg.Connection[Any], payload: dict[str, Json]
) -> StagedOperation:
    require_transaction(connection)
    operation_id, account_id, amount_cents = validate_payload(payload)
    row = connection.execute(
        "SELECT destination FROM celery_migration.route WHERE singleton FOR SHARE"
    ).fetchone()
    if row is None:
        raise RuntimeError("Missing application producer route")
    destination = cast(Destination, row[0])
    connection.execute(
        "INSERT INTO celery_migration.operation "
        "(operation_id, account_id, amount_cents, original_destination) VALUES (%s, %s, %s, %s) "
        "ON CONFLICT (operation_id) DO NOTHING",
        (operation_id, account_id, amount_cents, destination),
    )
    stored = connection.execute(
        "SELECT account_id, amount_cents FROM celery_migration.operation "
        "WHERE operation_id = %s FOR UPDATE",
        (operation_id,),
    ).fetchone()
    if stored != (account_id, amount_cents):
        raise ValueError("Operation identity was reused with a different business request")
    if destination == "celery":
        return StagedOperation(destination, None)
    task_id = Queue(connection).enqueue(
        TASK_TYPE,
        payload,
        EnqueueOptions(
            queue=QUEUE,
            max_attempts=5,
            idempotency=Idempotency(key=operation_id, ttl_ms=86_400_000),
        ),
    )
    connection.execute(
        "UPDATE celery_migration.operation SET workhorse_task_id = %s WHERE operation_id = %s",
        (task_id, operation_id),
    )
    return StagedOperation(destination, task_id)


def switch_producer(connection: psycopg.Connection[Any], destination: Destination) -> None:
    require_transaction(connection)
    if destination not in {"celery", "workhorse"}:
        raise ValueError("Unknown producer destination")
    connection.execute(
        "UPDATE celery_migration.route SET destination = %s WHERE singleton", (destination,)
    )


def apply_credit(database_url: str, payload: object) -> dict[str, Json]:
    operation_id, account_id, amount_cents = validate_payload(payload)
    with psycopg.connect(database_url) as connection, connection.transaction():
        stored = connection.execute(
            "SELECT account_id, amount_cents FROM celery_migration.operation "
            "WHERE operation_id = %s",
            (operation_id,),
        ).fetchone()
        if stored != (account_id, amount_cents):
            raise ValueError("Delivery does not match a committed business operation")
        inserted = connection.execute(
            "INSERT INTO celery_migration.effect (operation_id) VALUES (%s) "
            "ON CONFLICT (operation_id) DO NOTHING RETURNING operation_id",
            (operation_id,),
        ).fetchone()
        if inserted is not None:
            connection.execute(
                "UPDATE celery_migration.account SET credit_cents = credit_cents + %s "
                "WHERE account_id = %s",
                (amount_cents, account_id),
            )
    return {"operation_id": operation_id, "applied": inserted is not None}


def create_local_celery_task(database_url: str) -> Any:
    app = Celery("credit-migration-local", broker="memory://")
    app.conf.update(
        task_always_eager=True,
        task_eager_propagates=False,
        task_store_eager_result=False,
        task_serializer="json",
        accept_content=["json"],
    )

    def credit(payload: object) -> dict[str, Json]:
        return apply_credit(database_url, payload)

    return app.task(
        name=TASK_TYPE,
        autoretry_for=(psycopg.OperationalError,),
        retry_kwargs={"max_retries": 3},
        retry_backoff=True,
    )(credit)


def submit(database_url: str, celery_task: Any, payload: dict[str, Json]) -> StagedOperation:
    with psycopg.connect(database_url) as connection, connection.transaction():
        staged = stage_operation(connection, payload)
    if staged.destination == "celery":
        celery_task.delay(payload)
    return staged


def workhorse_handler(database_url: str) -> Callable[[Any, HandlerContext], dict[str, Json]]:
    def credit(payload: Any, _context: HandlerContext) -> dict[str, Json]:
        return apply_credit(database_url, payload)

    return credit


def unresolved_operations(connection: psycopg.Connection[Any]) -> list[dict[str, Json]]:
    rows = connection.execute(
        "SELECT operation.operation_id, operation.account_id, operation.amount_cents "
        "FROM celery_migration.operation AS operation "
        "LEFT JOIN celery_migration.effect AS effect USING (operation_id) "
        "WHERE effect.operation_id IS NULL ORDER BY operation.operation_id"
    ).fetchall()
    return [
        {"operation_id": operation_id, "account_id": account_id, "amount_cents": amount_cents}
        for operation_id, account_id, amount_cents in rows
    ]


def run_local_example() -> None:
    source = urlsplit(os.environ["DATABASE_URL_TEST"])
    if source.hostname not in {"localhost", "127.0.0.1", "::1"} or "test" not in source.path:
        raise ValueError("This local example requires the checkout's loopback test URL")
    name = f"{source.path.removeprefix('/')[:40]}_celery_{uuid4().hex[:10]}"
    admin_url = urlunsplit(source._replace(path="/postgres"))
    database_url = urlunsplit(source._replace(path=f"/{name}"))
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    try:
        with psycopg.connect(database_url, autocommit=True) as connection:
            connection.execute((Path(__file__).parents[2] / "sql/schema/current.sql").read_text())
            connection.execute(APPLICATION_SCHEMA)
            connection.execute("INSERT INTO celery_migration.account VALUES ('customer', 0)")
        celery_task = create_local_celery_task(database_url)
        payload = credit_payload("customer", "payment-001", 1500)
        submit(database_url, celery_task, payload)
        with psycopg.connect(database_url) as connection, connection.transaction():
            switch_producer(connection, "workhorse")
        staged = submit(database_url, celery_task, payload)
        with ConnectionPool(
            database_url, min_size=3, max_size=3, kwargs={"autocommit": True}
        ) as pool:
            worker = Worker(pool, queues=[QUEUE], concurrency=1).handle(
                TASK_TYPE, workhorse_handler(database_url)
            )
            worker.run_once()
        with psycopg.connect(database_url, autocommit=True) as observer:
            assert observer.execute(
                "SELECT credit_cents FROM celery_migration.account"
            ).fetchone() == (1500,)
            assert observer.execute("SELECT count(*) FROM celery_migration.effect").fetchone() == (
                1,
            )
            assert observer.execute(
                "SELECT state FROM workhorse.task_outcome WHERE task_id = %s", (staged.task_id,)
            ).fetchone() == ("succeeded",)
            assert unresolved_operations(observer) == []
        print("Real Celery eager + Workhorse worker: one committed credit, duplicate suppressed")
    finally:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE "{name}"')


if __name__ == "__main__":
    run_local_example()
