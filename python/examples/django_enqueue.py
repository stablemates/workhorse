from __future__ import annotations

import argparse

import django
import psycopg
from asgiref.sync import sync_to_async
from django.db import connections, transaction
from django.db.transaction import TransactionManagementError

from workhorse import EnqueueOptions, EnqueueResult, Json, Queue


def enqueue_in_atomic(
    task_type: str,
    payload: Json,
    *,
    using: str,
    options: EnqueueOptions | None = None,
) -> EnqueueResult:
    """Borrow the selected atomic block's connection for this enqueue only."""
    database = connections[using]
    database.validate_thread_sharing()
    if not database.in_atomic_block or database.get_autocommit():
        raise TransactionManagementError(
            "enqueue_in_atomic requires transaction.atomic(using=alias)"
        )
    connection = database.connection
    if not isinstance(connection, psycopg.Connection):
        raise TypeError("enqueue_in_atomic requires Django's PostgreSQL Psycopg 3 backend")
    if connection.closed or database.closed_in_transaction:
        raise TransactionManagementError("Django's atomic connection is closed")
    database.validate_no_broken_transaction()
    return Queue(connection).enqueue_with_result(task_type, payload, options)


def create_order(order_id: int, *, using: str) -> EnqueueResult:
    """Commit one example business row and its task through Django."""
    with transaction.atomic(using=using):
        with connections[using].cursor() as cursor:
            cursor.execute(
                "INSERT INTO django_orders (id, note) VALUES (%s, %s)",
                [order_id, "accepted"],
            )
        return enqueue_in_atomic("order.fulfill", {"order_id": order_id}, using=using)


async def create_order_async(order_id: int, *, using: str) -> EnqueueResult:
    """Run the whole transaction on Django's thread-sensitive sync executor."""
    return await sync_to_async(create_order, thread_sensitive=True)(order_id, using=using)


def main() -> None:
    parser = argparse.ArgumentParser(description="Enqueue with a Django-owned business transaction")
    parser.add_argument("--using", required=True, help="Django database alias")
    parser.add_argument("--order-id", required=True, type=int)
    arguments = parser.parse_args()
    django.setup()
    result = create_order(arguments.order_id, using=arguments.using)
    print(result.task_id)


if __name__ == "__main__":
    main()
