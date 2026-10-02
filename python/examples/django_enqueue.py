from __future__ import annotations

import argparse

import django
from asgiref.sync import sync_to_async
from django.db import connections, transaction

from workhorse import EnqueueResult
from workhorse.django import enqueue_in_atomic


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
