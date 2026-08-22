from __future__ import annotations

import asyncio
import sys
from uuid import uuid4

import asyncpg  # type: ignore[import-untyped]
import psycopg

from workhorse import AsyncQueue


async def run(database_url: str) -> None:
    suffix = uuid4().hex
    async with (
        await psycopg.AsyncConnection.connect(database_url) as connection,
        connection.transaction(),
    ):
        await AsyncQueue.from_psycopg(connection).enqueue(
            f"python-example-psycopg-{suffix}",
            {"driver": "psycopg"},
        )

    connection = await asyncpg.connect(database_url)
    try:
        transaction = connection.transaction()
        await transaction.start()
        await AsyncQueue.from_asyncpg(connection).enqueue(
            f"python-example-asyncpg-{suffix}",
            {"driver": "asyncpg"},
        )
        await transaction.commit()
    finally:
        await connection.close()


if __name__ == "__main__":
    asyncio.run(run(sys.argv[1]))
    print("Python async driver example completed")
