"""Give a worker its heartbeat reservation without a database.

`reserve` takes the reservation outside a run, for tests that drive rounds directly. The scripted
helpers let a worker over a scripted executor start a run on its dedicated heartbeat path.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from threading import Lock
from typing import Any, cast

import workhorse._pool_hub as pool_hub_module
from workhorse._heartbeat_round import ROUND_TIMEOUTS
from workhorse._pool_hub import ReservationSubscription
from workhorse._statements import (
    MINIMUM_SCHEMA_VERSION,
    PROTOCOL_VERSION,
    STATEMENTS,
    DriverStatement,
)
from workhorse.worker import Worker


def reserve(worker: Worker) -> ReservationSubscription:
    """Reserve the worker's heartbeat connection and start a run generation, as a startup does.

    The worker must have a private heartbeat executor factory. The reservation wakes the worker's
    dispatcher when a replacement connection arrives. Close the subscription to give the
    connection back.
    """
    reservation = worker._heartbeat_reservation(None)
    assert reservation is not None
    subscription = reservation.subscribe(worker.heartbeat_ms, worker._wake_dispatcher)
    # The deadline uses the reservation's own clock. A test can replace that clock with a fake one,
    # and a deadline from another clock would then pass at once or never.
    deadline = pool_hub_module.monotonic() + 5
    assert reservation.wait_ready(deadline), "the heartbeat connection never opened"
    with worker._state_lock:
        worker._run_generation += 1
        worker._reservation = reservation
    return subscription


# The answer of a database that has the schema and protocol this SDK needs.
COMPATIBLE_ROWS: list[dict[str, object]] = [
    {"kind": "schema", "version": MINIMUM_SCHEMA_VERSION},
    {"kind": "protocol", "version": PROTOCOL_VERSION},
]


class ScriptedPool:
    """A pool the worker never draws a connection from. The scripted executor answers every
    statement, and `ScriptedHeartbeats` gives the heartbeat connection.

    Its size leaves 8 connections after the listener and the heartbeat connection, so it does not
    cap the default cohorts (ADR 0076).
    """

    max_size = 10


class Compatible:
    """Answer the startup compatibility query, and send every other statement to `executor`."""

    def __init__(self, executor: Any) -> None:
        self._executor = executor

    def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[Mapping[str, object]]:
        if statement is STATEMENTS.compatibility:
            return [dict(row) for row in COMPATIBLE_ROWS]
        return cast(list[Mapping[str, object]], self._executor.rows(statement, parameters))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._executor, name)


class ScriptedHeartbeats:
    """A private source of heartbeat connections for a worker over a scripted executor.

    Each connection answers the heartbeat statement of a round with `status(task_id)` for each
    lease, and counts the rounds. Pass `open` as the worker's ``_heartbeat_executor_factory``.
    """

    def __init__(self, status: Callable[[str], str] = lambda _task_id: "accepted") -> None:
        self._status = status
        self._lock = Lock()
        self.rounds = 0

    def open(self) -> tuple[Any, Callable[[], None]]:
        return _ScriptedHeartbeatConnection(self), lambda: None

    def _answer(self, parameters: Sequence[object]) -> list[Mapping[str, object]]:
        with self._lock:
            self.rounds += 1
        batches = json.loads(str(parameters[0]))
        return [
            {"batch": ordinal, "task_id": lease["taskId"], "status": self._status(lease["taskId"])}
            for ordinal, batch in enumerate(batches, start=1)
            for lease in batch["leases"]
        ]


class _ScriptedHeartbeatConnection:
    def __init__(self, heartbeats: ScriptedHeartbeats) -> None:
        self._heartbeats = heartbeats

    def command(self, _statement: DriverStatement, _parameters: Sequence[object] = ()) -> None:
        pass

    def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[Mapping[str, object]]:
        if statement is ROUND_TIMEOUTS:
            return [{}]
        return self._heartbeats._answer(parameters)
