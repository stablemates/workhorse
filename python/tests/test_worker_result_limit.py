"""Handler results the worker must refuse before it sends a completion statement."""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from threading import Lock
from typing import Any

import psycopg
import pytest
from test_worker_dispatch import FullTierRejection, task_row

from workhorse import TaskValueSizeLimitError, Worker
from workhorse._contracts import jsonb_text_bytes
from workhorse._statements import STATEMENTS, DriverStatement
from workhorse.worker import _encode_result

TASK = "result.limit"
# The contract accepts every result the contracted test returns, so only the size check can refuse.
RESULT_SCHEMA = {"type": ["string", "object"]}


class DatabaseBackstop(Exception):
    """The error complete_v1 raises for a result over the task's limit."""


class Settlements:
    """Answer claims from a backlog and record every completion and failure the worker sends.

    Like complete_v1, the scripted completion raises for a result over the task's limit, so a
    worker that sends one stops with that error.
    """

    def __init__(self, rows: Sequence[dict[str, object]], *, fast: bool = False) -> None:
        self._lock = Lock()
        self._backlog = list(rows)
        self._limits = {str(row["task_id"]): int(str(row["result_max_bytes"])) for row in rows}
        self.fast = fast
        self.completed: dict[str, str] = {}
        self.failed: dict[str, dict[str, object]] = {}
        self.contract_lookups: list[tuple[object, object]] = []

    def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> list[Any]:
        if statement is STATEMENTS.claim_many:
            limit = parameters[2]
            assert isinstance(limit, int)
            return self._take(limit)
        if statement is STATEMENTS.complete_many_and_claim:
            if not self.fast:
                raise FullTierRejection
            task_ids, results, limit = parameters[1], parameters[3], parameters[5]
            assert isinstance(task_ids, list)
            assert isinstance(results, list)
            assert isinstance(limit, int)
            for task_id, result in zip(task_ids, results, strict=True):
                self._complete(str(task_id), str(result))
            claimed = self._take(limit)
            rows: list[dict[str, object]] = [dict(row) for row in claimed] or [
                dict.fromkeys(task_row(0, TASK))
            ]
            rows[0]["accepted"] = list(task_ids)
            return rows
        if statement is STATEMENTS.complete:
            self._complete(str(parameters[0]), str(parameters[3]))
            return [{"accepted": True}]
        if statement is STATEMENTS.get_contract:
            self.contract_lookups.append((parameters[0], parameters[1]))
            return [{"schema": {"payload": {}, "result": RESULT_SCHEMA}}]
        if statement is STATEMENTS.fail:
            with self._lock:
                self.failed[str(parameters[0])] = json.loads(str(parameters[3]))
            return [{"state": "failed"}]
        return []

    def _take(self, limit: int) -> list[dict[str, object]]:
        with self._lock:
            claimed, self._backlog = self._backlog[:limit], self._backlog[limit:]
        return claimed

    def _complete(self, task_id: str, result: str) -> None:
        if len(result.encode()) > self._limits[task_id]:
            raise DatabaseBackstop(f"{task_id} result exceeds its configured size limit")
        with self._lock:
            self.completed[task_id] = result


def limited_row(sequence: int, result_max_bytes: int) -> dict[str, object]:
    return {**task_row(sequence, TASK), "result_max_bytes": result_max_bytes, "max_attempts": 1}


def contracted_row(sequence: int, result_max_bytes: int) -> dict[str, object]:
    return {**limited_row(sequence, result_max_bytes), "contract_version": "v1"}


def task_id(sequence: int) -> str:
    return str(task_row(sequence, TASK)["task_id"])


def scripted_worker(executor: Settlements, results: dict[int, object]) -> Worker:
    worker = Worker(
        object(),  # type: ignore[arg-type]
        queue="dispatch",
        worker_id="python-result-limit",
        concurrency=1,
        registry_interval_ms=0,
        shared_heartbeats=True,
        _executor=executor,
    )
    worker._compatibility.assert_compatible = lambda: None  # type: ignore[method-assign]
    worker._notification_connection_factory = None  # type: ignore[assignment]

    def handle(payload: object, _context: object) -> object:
        assert isinstance(payload, dict)
        return results[int(payload["sequence"])]

    return worker.handle(TASK, handle)


@pytest.mark.parametrize("fast", [False, True], ids=["full-tier", "fast-tier"])
def test_oversized_result_fails_its_task_and_the_worker_keeps_running(fast: bool) -> None:
    executor = Settlements([limited_row(1, 64), limited_row(2, 64)], fast=fast)
    worker = scripted_worker(executor, {1: "x" * 64, 2: {"ok": True}})

    worker.run_once()

    assert list(executor.failed) == [task_id(1)]
    assert executor.failed[task_id(1)]["name"] == "TaskValueSizeLimitError"
    assert executor.failed[task_id(1)]["message"] == (
        "result.limit result exceeds its configured size limit"
    )
    assert executor.completed == {task_id(2): '{"ok":true}'}


@pytest.mark.parametrize("fast", [False, True], ids=["full-tier", "fast-tier"])
def test_oversized_contracted_result_fails_after_it_passes_its_contract(fast: bool) -> None:
    executor = Settlements([contracted_row(1, 64), contracted_row(2, 64)], fast=fast)
    worker = scripted_worker(executor, {1: "x" * 64, 2: {"ok": True}})

    worker.run_once()

    assert executor.contract_lookups == [(TASK, "v1")]
    assert list(executor.failed) == [task_id(1)]
    assert executor.failed[task_id(1)]["name"] == "TaskValueSizeLimitError"
    assert executor.completed == {task_id(2): '{"ok":true}'}


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf], ids=["nan", "inf", "-inf"])
@pytest.mark.parametrize("fast", [False, True], ids=["full-tier", "fast-tier"])
def test_non_finite_number_fails_its_task_before_completion(value: float, fast: bool) -> None:
    executor = Settlements([limited_row(1, 1_048_576), limited_row(2, 1_048_576)], fast=fast)
    worker = scripted_worker(executor, {1: {"score": value}, 2: [1]})

    worker.run_once()

    assert list(executor.failed) == [task_id(1)]
    assert executor.failed[task_id(1)]["name"] == "ValueError"
    assert executor.completed == {task_id(2): "[1]"}


def test_result_at_the_default_limit_completes_and_one_byte_more_fails() -> None:
    # A JSON string costs its two quotes, so these results measure exactly 1 MiB and one byte more.
    at_limit = "x" * (1_048_576 - 2)
    executor = Settlements([limited_row(1, 1_048_576), limited_row(2, 1_048_576)])
    worker = scripted_worker(executor, {1: at_limit, 2: at_limit + "x"})

    worker.run_once()

    assert list(executor.completed) == [task_id(1)]
    assert list(executor.failed) == [task_id(2)]
    assert executor.failed[task_id(2)]["name"] == "TaskValueSizeLimitError"


@pytest.mark.parametrize(
    ("value", "jsonb_text_bytes"),
    [
        # PostgreSQL prints a space after every separator in jsonb text.
        ({"a": 1, "b": [1, 2]}, len('{"a": 1, "b": [1, 2]}')),
        ([], 2),
        ({}, 2),
        ([None, True, False], len("[null, true, false]")),
        # Multibyte characters count their UTF-8 bytes, not their code points or \u escapes.
        ("é", 4),
        ("🙂", 6),
        ({"ключ": "значение"}, len('{"ключ": "значение"}'.encode())),
        # Escaped characters count their escape sequences.
        ('"\\', len('"\\"\\\\"')),
        ("\n\t\b\f\r", len('"\\n\\t\\b\\f\\r"')),
        ("\x01\x1f", len('"\\u0001\\u001f"')),
        ("\x7f", 3),
        # Numbers count their numeric text, which never uses an exponent.
        (1e16, len("10000000000000000")),
        (1.5e300, 301),
        (1e-5, len("0.00001")),
        (-2.5e-7, len("-0.00000025")),
        (0.1, 3),
        # Numeric text has no negative zero.
        (-0.0, 3),
        (10**30, 31),
        (-7, 2),
    ],
)
def test_measure_follows_jsonb_text_length(value: object, jsonb_text_bytes: int) -> None:
    _encode_result(TASK, value, jsonb_text_bytes)
    with pytest.raises(TaskValueSizeLimitError) as raised:
        _encode_result(TASK, value, jsonb_text_bytes - 1)
    assert raised.value.actual_bytes == jsonb_text_bytes
    assert raised.value.max_bytes == jsonb_text_bytes - 1
    assert raised.value.value_kind == "result"
    assert raised.value.task_type == TASK


def deeply_nested(depth: int) -> object:
    # The exponent in 1e16 forces the exact measure, which must not lose nesting depth.
    value: object = 1e16
    for _ in range(depth):
        value = [value]
    return value


@pytest.mark.parametrize("fast", [False, True], ids=["full-tier", "fast-tier"])
def test_deeply_nested_result_under_the_limit_completes(fast: bool) -> None:
    executor = Settlements([limited_row(1, 1_048_576)], fast=fast)
    worker = scripted_worker(executor, {1: deeply_nested(550)})

    worker.run_once()

    assert executor.failed == {}
    assert list(executor.completed) == [task_id(1)]


def test_encoded_result_is_compact_json() -> None:
    assert _encode_result(TASK, {"a": [1, "é"]}, 1_048_576) == '{"a":[1,"\\u00e9"]}'


def test_measure_matches_postgresql(database_url: str) -> None:
    corpus: list[object] = [
        {"nested": {"list": [1, 2.5, -0.0, 1e-7, 3e21], "flag": False}, "empty": [{}, []]},
        ["é", "🙂", "\u2028", "\x01\x1f\x7f", '"\\/', "\n\t\b\f\r"],
        {"ключ": "значение", "": None, "a b": True},
        [1e16, 1.5e300, -2.5e-7, 0.1, 123.456, 10**40, -(10**40), 5e-324, 1.7976931348623157e308],
        deeply_nested(550),
    ]
    with psycopg.connect(database_url, autocommit=True) as connection:
        for value in corpus:
            encoded = json.dumps(value, separators=(",", ":"))
            measured = connection.execute(
                "SELECT octet_length(%s::jsonb::text)", (encoded,)
            ).fetchone()
            assert measured == (jsonb_text_bytes(json.loads(encoded)),), encoded
