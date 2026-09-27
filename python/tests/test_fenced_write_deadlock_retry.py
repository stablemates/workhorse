"""Fenced writes over a scripted executor: which failures are sent again, and what surfaces."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import psycopg.errors
import pytest

from workhorse._statements import STATEMENTS, DriverStatement
from workhorse.worker import _FENCED_WRITE_DEADLOCK_ATTEMPTS, _fenced_write_rows


class ScriptedWrites:
    """Raise the given failures in turn, then answer with one accepted row."""

    dialect = "psycopg"

    def __init__(self, failures: Sequence[Exception]) -> None:
        self._failures = list(failures)
        self.sent: list[DriverStatement] = []

    def rows(self, statement: DriverStatement, _parameters: Sequence[object] = ()) -> list[Any]:
        self.sent.append(statement)
        if len(self.sent) <= len(self._failures):
            raise self._failures[len(self.sent) - 1]
        return [{"accepted": True}]


def deadlock() -> Exception:
    return psycopg.errors.DeadlockDetected("deadlock detected")


@pytest.mark.parametrize(
    "statement",
    [STATEMENTS.complete, STATEMENTS.fail, STATEMENTS.heartbeat_many, STATEMENTS.update_progress],
)
def test_sends_a_deadlock_victim_again(statement: DriverStatement) -> None:
    executor = ScriptedWrites([deadlock()] * (_FENCED_WRITE_DEADLOCK_ATTEMPTS - 1))

    assert _fenced_write_rows(executor, statement, ()) == [{"accepted": True}]
    assert executor.sent == [statement] * _FENCED_WRITE_DEADLOCK_ATTEMPTS


def test_raises_the_last_deadlock_after_every_attempt() -> None:
    deadlocks = [deadlock() for _ in range(_FENCED_WRITE_DEADLOCK_ATTEMPTS)]
    executor = ScriptedWrites(deadlocks)

    with pytest.raises(psycopg.errors.DeadlockDetected) as raised:
        _fenced_write_rows(executor, STATEMENTS.complete, ())
    assert raised.value is deadlocks[-1]
    assert len(executor.sent) == 3


def test_raises_the_deadlock_that_aborted_a_caller_transaction() -> None:
    original = deadlock()
    executor = ScriptedWrites(
        [original, psycopg.errors.InFailedSqlTransaction("current transaction is aborted")]
    )

    with pytest.raises(psycopg.errors.DeadlockDetected) as raised:
        _fenced_write_rows(executor, STATEMENTS.fail, ())
    assert raised.value is original
    assert len(executor.sent) == 2


@pytest.mark.parametrize(
    "failure",
    [
        psycopg.errors.SerializationFailure("serialization failure"),
        psycopg.errors.InFailedSqlTransaction("current transaction is aborted"),
    ],
)
def test_sends_other_failures_once(failure: Exception) -> None:
    executor = ScriptedWrites([failure])

    with pytest.raises(type(failure)) as raised:
        _fenced_write_rows(executor, STATEMENTS.complete, ())
    assert raised.value is failure
    assert len(executor.sent) == 1
