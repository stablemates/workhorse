"""Commits a SQLAlchemy async session write and a task in one transaction by enqueuing through the
session's enlisted psycopg connection.

Documentation: https://workhorse.run/docs/sqlalchemy
"""

from __future__ import annotations

import asyncio
import sys
from uuid import uuid4

import psycopg
from sqlalchemy import String
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from workhorse import AsyncQueue


class Base(DeclarativeBase):
    pass


class Account(Base):
    __tablename__ = "sqlalchemy_async_example_account"

    id: Mapped[str] = mapped_column(String, primary_key=True)


async def run(database_url: str) -> str:
    engine = create_async_engine(make_url(database_url).set(drivername="postgresql+psycopg"))
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

        sessions = async_sessionmaker(engine)
        async with sessions.begin() as session:
            account = Account(id=uuid4().hex)
            session.add(account)
            await session.flush()
            connection = await session.connection()
            raw = await connection.get_raw_connection()
            driver = raw.driver_connection
            if not isinstance(driver, psycopg.AsyncConnection):
                raise TypeError("This recipe requires SQLAlchemy's asynchronous Psycopg dialect")
            return await AsyncQueue.from_psycopg(driver).enqueue(
                "account.created", {"accountId": account.id}
            )
    finally:
        await engine.dispose()


if __name__ == "__main__":
    print(asyncio.run(run(sys.argv[1])))
