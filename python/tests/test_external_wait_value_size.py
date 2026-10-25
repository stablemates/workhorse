from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

import pytest

from workhorse import AsyncQueue, Queue
from workhorse._external_waits import MAX_EXTERNAL_WAIT_VALUE_BYTES, encode_wait_value

# Compact JSON writes 30,000 zeros in 60,001 bytes. PostgreSQL's jsonb text puts a space after each
# comma, so it writes the same array in 90,000 bytes, which is above the limit.
ZEROS = [0] * 30_000
TASK_ID = "00000000-0000-4000-8000-000000000001"
REFUSAL = "the size check must refuse the value before a statement runs"


class _RefusingConnection:
    """Refuses every statement, the compatibility probe included."""

    def __init__(self) -> None:
        self.statements = 0

    def cursor(self, *, row_factory: Any = None) -> Any:  # noqa: ARG002
        self.statements += 1
        raise AssertionError(REFUSAL)


class _RefusingAsyncpgConnection:
    """Refuses every statement, the compatibility probe included."""

    def __init__(self) -> None:
        self.statements = 0

    async def fetch(self, _sql: str, *_parameters: object) -> Sequence[Mapping[str, object]]:
        self.statements += 1
        raise AssertionError(REFUSAL)


def test_the_value_is_below_the_limit_as_compact_json() -> None:
    assert len(json.dumps(ZEROS, separators=(",", ":")).encode()) < MAX_EXTERNAL_WAIT_VALUE_BYTES


def test_refuses_a_signal_payload_whose_jsonb_text_exceeds_the_limit() -> None:
    connection = _RefusingConnection()
    with pytest.raises(ValueError, match="Signal payload must encode to at most 65536 bytes"):
        Queue(connection).send_signal(
            TASK_ID,
            "approval",
            ZEROS,
            idempotency_key="oversized",
            requested_by="approval-service",
        )
    assert connection.statements == 0


def test_refuses_a_human_wait_result_whose_jsonb_text_exceeds_the_limit() -> None:
    connection = _RefusingConnection()
    with pytest.raises(ValueError, match="Human wait result must encode to at most 65536 bytes"):
        Queue(connection).complete_human_wait(
            TASK_ID,
            "review",
            ZEROS,
            idempotency_key="oversized-result",
            requested_by="operator",
        )
    assert connection.statements == 0


@pytest.mark.asyncio
async def test_the_async_queue_refuses_both_values_before_a_statement_runs() -> None:
    connection = _RefusingAsyncpgConnection()
    queue = AsyncQueue.from_asyncpg(connection)
    with pytest.raises(ValueError, match="Signal payload must encode to at most 65536 bytes"):
        await queue.send_signal(
            TASK_ID,
            "approval",
            ZEROS,
            idempotency_key="oversized",
            requested_by="approval-service",
        )
    with pytest.raises(ValueError, match="Human wait result must encode to at most 65536 bytes"):
        await queue.complete_human_wait(
            TASK_ID,
            "review",
            ZEROS,
            idempotency_key="oversized-result",
            requested_by="operator",
        )
    assert connection.statements == 0


def test_refuses_a_human_wait_context_whose_jsonb_text_exceeds_the_limit() -> None:
    # HandlerContext.wait_for_human encodes its context with this function before its statement.
    with pytest.raises(ValueError, match="Human wait context must encode to at most 65536 bytes"):
        encode_wait_value(ZEROS, "Human wait context")
