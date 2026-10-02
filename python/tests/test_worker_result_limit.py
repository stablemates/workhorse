"""Handler results the worker must refuse before it sends a completion statement."""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from threading import Lock
from typing import Any

import psycopg
import pytest
from psycopg_pool import ConnectionPool
from test_worker_dispatch import FullTierRejection, task_row

from workhorse import Admin, AdminAudit, EnqueueOptions, Queue, TaskValueSizeLimitError, Worker
from workhorse._contracts import jsonb_text_bytes
from workhorse._statements import STATEMENTS, DriverStatement
from workhorse.worker import _encode_result, _has_unstorable_escape

TASK = "result.limit"
# The contract accepts every result the contracted test returns, so only the size check can refuse.
RESULT_SCHEMA = {"type": ["string", "object"]}


class DatabaseBackstop(Exception):
    """The error complete_v1 raises for a result over the task's limit or one jsonb refuses."""


def jsonb_refuses(encoded: str) -> bool:
    """Report a string or key holding NUL or a lone surrogate, which a ::jsonb cast refuses."""

    pending = [json.loads(encoded)]
    while pending:
        value = pending.pop()
        if isinstance(value, str):
            if any(c == "\x00" or 0xD800 <= ord(c) <= 0xDFFF for c in value):
                return True
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, dict):
            pending.extend(value)
            pending.extend(value.values())
    return False


class Settlements:
    """Answer claims from a backlog and record every completion and failure the worker sends.

    Like complete_v1, the scripted completion raises for a result over the task's limit or one that
    jsonb refuses, so a worker that sends one stops with that error.
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
        if jsonb_refuses(result):
            raise DatabaseBackstop("unsupported Unicode escape sequence")
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


# PostgreSQL jsonb refuses a NUL character and a surrogate outside a pair, at any depth and in keys.
UNSTORABLE_RESULTS: dict[str, object] = {
    "nul": "\x00",
    "nested-nul": {"items": ["ok", {"note": "a\x00b"}]},
    "nul-key": {"k\x00": 1},
    "lone-high-surrogate": "\ud800",
    "lone-low-surrogate": "\udc00",
    "nested-surrogate": [1, ["\ud83dx"]],
    "surrogate-key": {"\udfff": True},
    "reversed-pair": "\ude00\ud83d",
}
UNSTORABLE_RESULT_MESSAGE = (
    "result.limit result contains a NUL character or an unpaired surrogate, which PostgreSQL jsonb"
    " cannot store"
)
# Neighbours of those values that jsonb stores, so the check must accept them.
STORABLE_RESULTS: dict[str, object] = {
    "escaped-backslash-u0000": "\\u0000",
    "escaped-backslash-ud800": {"\\ud800": "\\\\ud800"},
    "astral": "🙂",
    "control": "\x01\x1f\u2028",
    "bmp": "é\ufffd",
}


@pytest.mark.parametrize("value", UNSTORABLE_RESULTS.values(), ids=UNSTORABLE_RESULTS.keys())
@pytest.mark.parametrize("fast", [False, True], ids=["full-tier", "fast-tier"])
def test_result_jsonb_cannot_store_fails_its_task_before_completion(
    value: object, fast: bool
) -> None:
    executor = Settlements([limited_row(1, 1_048_576), limited_row(2, 1_048_576)], fast=fast)
    worker = scripted_worker(executor, {1: value, 2: {"ok": True}})

    worker.run_once()

    assert list(executor.failed) == [task_id(1)]
    error = executor.failed[task_id(1)]
    assert error["name"] == "ValueError"
    assert error["message"] == UNSTORABLE_RESULT_MESSAGE
    # The failure envelope itself must survive the jsonb cast that fail_v1 performs.
    assert not jsonb_refuses(json.dumps(error))
    assert executor.completed == {task_id(2): '{"ok":true}'}


class CompletionOutage(Settlements):
    """Refuse every completion the way a lost connection would."""

    def _complete(self, task_id: str, result: str) -> None:
        del task_id, result
        raise psycopg.OperationalError("connection lost during completion")


@pytest.mark.parametrize("fast", [False, True], ids=["full-tier", "fast-tier"])
def test_operational_completion_error_still_stops_the_worker(fast: bool) -> None:
    executor = CompletionOutage([limited_row(1, 1_048_576)], fast=fast)
    worker = scripted_worker(executor, {1: {"ok": True}})

    with pytest.raises(psycopg.OperationalError, match="connection lost during completion"):
        worker.run_once()

    # Only a value the worker refuses becomes a task failure; a database failure is not one.
    assert executor.failed == {}


@pytest.mark.parametrize("value", STORABLE_RESULTS.values(), ids=STORABLE_RESULTS.keys())
def test_result_jsonb_can_store_completes(value: object) -> None:
    executor = Settlements([limited_row(1, 1_048_576)], fast=True)
    worker = scripted_worker(executor, {1: value})

    worker.run_once()

    assert executor.failed == {}
    assert executor.completed == {task_id(1): json.dumps(value, separators=(",", ":"))}


class _FullScanSentinel:
    """Stand in for the escape pattern so a test can tell whether the full scan ran."""

    def finditer(self, encoded: str) -> object:
        raise AssertionError(f"ordinary text reached the full escape scan: {encoded[:40]}")


@pytest.mark.parametrize(
    "value",
    ["é" * 512, {"ключ": "値 <a href>&amp;"}, "\U0001f600" * 4],
    ids=["latin", "mixed", "emoji"],
)
def test_ordinary_non_ascii_text_skips_the_full_escape_scan(
    value: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    # json.dumps escapes every non-ASCII character, so ordinary text is full of \u escapes. Only
    # \u0000 or a \ud or \uD escape may send it on to the full scan.
    encoded = json.dumps(value, separators=(",", ":"))
    if "\\ud" not in encoded:
        monkeypatch.setattr("workhorse.worker._JSON_ESCAPE", _FullScanSentinel())
    assert not _has_unstorable_escape(encoded)
    assert _encode_result(TASK, value, 1_048_576) == encoded


@pytest.mark.parametrize(
    ("encoded", "refused"),
    [
        (r'"\ud83d\ude00"', False),
        (r'"\uD83D\uDE00"', False),
        (r'"\u0000"', True),
        (r'"\uD800"', True),
        (r'"\uDC00x"', True),
        (r'"<\u00e9\ud83d"', True),
    ],
)
def test_escape_scan_reads_either_hex_case(encoded: str, refused: bool) -> None:
    assert _has_unstorable_escape(encoded) is refused


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


def test_unstorable_results_match_postgresql(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        for value in STORABLE_RESULTS.values():
            encoded = json.dumps(value, separators=(",", ":"))
            stored = connection.execute("SELECT %s::jsonb", (encoded,)).fetchone()
            assert stored == (value,), encoded
            assert _encode_result(TASK, value, 1_048_576) == encoded
        for value in UNSTORABLE_RESULTS.values():
            encoded = json.dumps(value, separators=(",", ":"))
            with pytest.raises(psycopg.DataError):
                connection.execute("SELECT %s::jsonb", (encoded,))
            with pytest.raises(ValueError, match="PostgreSQL jsonb cannot store"):
                _encode_result(TASK, value, 1_048_576)


@pytest.mark.parametrize("fast", [False, True], ids=["full-tier", "fast-tier"])
def test_unstorable_result_fails_under_its_retry_policy_and_the_worker_keeps_running(
    database_url: str, worker_pool: ConnectionPool, fast: bool
) -> None:
    queue_name = f"python-unstorable-result-{'fast' if fast else 'full'}"
    with psycopg.connect(database_url, autocommit=True) as operator:
        if fast:
            audit = AdminAudit(
                actor="python-result-test", reason="exercise the fast tier", request_id=queue_name
            )
            assert Admin(operator).set_queue_tier(queue_name, "fast", audit) == "fast"
        queue = Queue(operator, default_queue=queue_name)
        retried = EnqueueOptions(max_attempts=2, retry_policy={"type": "fixed", "delayMs": 0})
        bad_id = queue.enqueue(TASK, {"bad": True}, retried)
        good_id = queue.enqueue(TASK, {"bad": False}, retried)

    def handle(payload: object, _context: object) -> object:
        assert isinstance(payload, dict)
        return {"note": "a\x00b"} if payload["bad"] else {"ok": True}

    # Two slots put the bad and the good task in one claim, so on the fast tier the good task's
    # completion is a batch member beside a task that fails.
    worker = Worker(
        worker_pool,
        queue=queue_name,
        worker_id=f"python-unstorable-result-{'fast' if fast else 'full'}",
        concurrency=2,
        registry_interval_ms=0,
    ).handle(TASK, handle)
    for _ in range(3):
        worker.run_once()

    outcome_table, attempt_column = (
        ("fast_task_outcome", "attempt") if fast else ("task_outcome", "current_attempt")
    )
    with psycopg.connect(database_url, autocommit=True) as observer:
        rows = observer.execute(
            f"SELECT task_id::text, state, {attempt_column}, error->>'name', error->>'message' "
            f"FROM workhorse.{outcome_table} WHERE task_id = ANY(%s::uuid[])",
            ([bad_id, good_id],),
        ).fetchall()
    assert sorted(rows) == sorted(
        [
            (
                bad_id,
                "failed",
                2,
                "ValueError",
                UNSTORABLE_RESULT_MESSAGE,
            ),
            (good_id, "succeeded", 1, None, None),
        ]
    )
