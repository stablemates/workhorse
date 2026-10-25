"""The category of a failed heartbeat round in `workhorse.worker.heartbeat.round_failure` (SM-1704).

A round fails when it raises before PostgreSQL returns a status for its leases. The classifier reads
the error and its chain and gives one bounded `workhorse.heartbeat.failure_reason` value.
"""

from __future__ import annotations

import socket

import asyncpg
import psycopg
import pytest
from psycopg_pool import PoolTimeout

from workhorse._heartbeat_round import HeartbeatRoundExpired, HeartbeatRoundExpiredCleanly
from workhorse._telemetry import heartbeat_round_failure_reason


class _ServerError(Exception):
    """A driver error that carries a SQLSTATE, as psycopg and asyncpg errors do."""

    def __init__(self, message: str, sqlstate: str) -> None:
        super().__init__(message)
        self.sqlstate = sqlstate


def _wrapped(error: BaseException, outer: BaseException) -> BaseException:
    """`outer`, raised from `error`."""
    try:
        try:
            raise error
        except BaseException as inner:
            raise outer from inner
    except BaseException as raised:
        return raised


def _raised_during(error: BaseException, outer: BaseException) -> BaseException:
    """`outer`, raised while `error` was handled, so `error` is its `__context__`."""
    try:
        try:
            raise error
        except BaseException:
            raise outer  # noqa: B904
    except BaseException as raised:
        return raised


def _cycle() -> BaseException:
    first = RuntimeError("first")
    second = RuntimeError("second")
    first.__cause__ = second
    second.__cause__ = first
    return first


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        pytest.param(HeartbeatRoundExpired("deadline"), "timeout", id="round-deadline"),
        pytest.param(HeartbeatRoundExpiredCleanly("busy"), "timeout", id="clean-round-deadline"),
        pytest.param(
            _wrapped(HeartbeatRoundExpired("deadline"), RuntimeError("round")),
            "timeout",
            id="wrapped-round-deadline",
        ),
        pytest.param(_ServerError("canceling statement", "57014"), "timeout", id="57014"),
        pytest.param(_ServerError("idle in transaction", "25P03"), "timeout", id="25P03"),
        pytest.param(
            psycopg.errors.QueryCanceled("canceling statement due to statement timeout"),
            "timeout",
            id="psycopg-query-canceled-class",
        ),
        pytest.param(ConnectionResetError("reset"), "connection", id="connection-reset"),
        pytest.param(BrokenPipeError("pipe"), "connection", id="broken-pipe"),
        pytest.param(socket.gaierror("dns"), "connection", id="dns"),
        pytest.param(
            _wrapped(ConnectionRefusedError("refused"), RuntimeError("query failed")),
            "connection",
            id="wrapped-socket-error",
        ),
        pytest.param(
            _raised_during(ConnectionResetError("reset"), RuntimeError("cleanup failed")),
            "connection",
            id="context-socket-error",
        ),
        pytest.param(
            ExceptionGroup("round", [ValueError("value"), ConnectionResetError("reset")]),
            "connection",
            id="exception-group-member",
        ),
        pytest.param(
            psycopg.OperationalError("the connection is closed"),
            "connection",
            id="psycopg-closed-connection",
        ),
        pytest.param(PoolTimeout("couldn't get a connection"), "connection", id="pool-timeout"),
        pytest.param(
            asyncpg.InterfaceError("cannot call Connection.fetch(): connection is closed"),
            "connection",
            id="asyncpg-closed-connection",
        ),
        pytest.param(_ServerError("connection failure", "08006"), "connection", id="class-08"),
        pytest.param(_ServerError("admin shutdown", "57P01"), "connection", id="57P01"),
        pytest.param(_ServerError("crash shutdown", "57P02"), "connection", id="57P02"),
        pytest.param(_ServerError("cannot connect now", "57P03"), "connection", id="57P03"),
        pytest.param(_ServerError("deadlock detected", "40P01"), "database", id="other-sqlstate"),
        pytest.param(
            _wrapped(_ServerError("deadlock detected", "40P01"), RuntimeError("round")),
            "database",
            id="wrapped-sqlstate",
        ),
        pytest.param(
            asyncpg.InterfaceError("another operation is in progress"),
            "other",
            id="asyncpg-interface-misuse",
        ),
        pytest.param(RuntimeError("unexpected"), "other", id="no-sqlstate"),
        pytest.param(_cycle(), "other", id="cause-cycle"),
    ],
)
def test_a_failed_round_reports_a_bounded_reason(error: BaseException, reason: str) -> None:
    assert heartbeat_round_failure_reason(error) == reason
