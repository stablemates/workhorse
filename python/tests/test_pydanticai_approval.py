from __future__ import annotations

import asyncio
import importlib.util
import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic_ai import (
    Agent,
    CancellationToken,
    DeferredToolRequests,
    ModelRetry,
    RunCancelled,
    models as ai_models,
)
from pydantic_ai.exceptions import UnexpectedModelBehavior, UserError
from pydantic_ai.messages import (
    ModelMessagesTypeAdapter,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel

from workhorse import AsyncWorker, EnqueueOptions, HumanWaitIdempotencyConflictError, Queue

EXAMPLE = Path(__file__).parents[1] / "examples/pydanticai_approval.py"
SPEC = importlib.util.spec_from_file_location("pydanticai_recipe", EXAMPLE)
assert SPEC is not None and SPEC.loader is not None
recipe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recipe)
REQUEST = {"account": "account-a", "amount": 7}


@pytest.fixture(autouse=True)
def forbid_models(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ai_models, "ALLOW_MODEL_REQUESTS", False)
    monkeypatch.setenv("PYDANTIC_AI_NO_BANNER", "1")


def row(database_url: str, task_id: str) -> dict[str, Any]:
    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        observed = connection.execute(
            "SELECT * FROM pydanticai_conversation WHERE task_id = %s", (task_id,)
        ).fetchone()
    assert observed is not None
    return observed


def credit(database_url: str) -> int:
    with psycopg.connect(database_url) as connection:
        return connection.execute(
            "SELECT coalesce(sum(credit), 0) FROM pydanticai_account"
        ).fetchone()[0]


def outcome(database_url: str, task_id: str) -> tuple[Any, ...] | None:
    with psycopg.connect(database_url) as connection:
        return connection.execute(
            "SELECT state, result, error FROM workhorse.task_outcome WHERE task_id = %s", (task_id,)
        ).fetchone()


def enqueue(database_url: str, options: EnqueueOptions | None = None) -> str:
    with psycopg.connect(database_url) as connection:
        connection.execute(recipe.DDL)
        task_id = Queue(connection).enqueue(
            recipe.TASK_TYPE, REQUEST, options or EnqueueOptions(max_attempts=3)
        )
        connection.execute(
            "INSERT INTO pydanticai_conversation (task_id, recipe, framework_version, request) "
            "VALUES (%s, %s, %s, %s)",
            (task_id, recipe.RECIPE, recipe.VERSION, Jsonb(REQUEST)),
        )
        return task_id


def promote(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute(
            "UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1 second' "
            "WHERE state = 'scheduled'"
        )
        connection.execute("SELECT * FROM workhorse.tick_v1(100, 100)")


def worker(database_url: str, pool: Any, **options: Any) -> AsyncWorker:
    return AsyncWorker.from_psycopg(pool, retry_delay_ms=60_000).handle(
        recipe.TASK_TYPE, recipe.make_handler(database_url, **options)
    )


@pytest.mark.parametrize("approved", [True, False])
async def test_native_wait_resume_and_server_history(
    database_url: str, async_psycopg_pool: Any, approved: bool
) -> None:
    task_id = enqueue(database_url)
    running = worker(database_url, async_psycopg_pool)
    assert await running.run_once()
    initial = row(database_url, task_id)
    history, pending = recipe.decode_pending(initial)
    assert len(pending.approvals) == 1
    assert credit(database_url) == 0
    with pytest.raises(ValueError, match="tool call IDs"):
        pending.build_results(approvals={"client-fabricated": True})
    assert (
        await recipe.complete_decision(database_url, task_id, approved, actor="local-reviewer")
        == "completed"
    )
    assert await running.run_once()
    final = row(database_url, task_id)
    result_messages = ModelMessagesTypeAdapter.validate_json(final["result_history"])
    assert initial["history"] == final["history"]
    assert history[-1].run_id != result_messages[-1].run_id
    assert final["decision"] is approved
    assert final["requests"] == 2
    assert credit(database_url) == (7 if approved else 0)
    assert outcome(database_url, task_id)[:2] == ("succeeded", "Reviewed local credit")
    assert (
        await recipe.complete_decision(database_url, task_id, approved, actor="local-reviewer")
        == "duplicate"
    )
    with pytest.raises(HumanWaitIdempotencyConflictError):
        await recipe.complete_decision(database_url, task_id, not approved, actor="local-reviewer")


@pytest.mark.parametrize(
    "boundary", ["history-committed", "decision-committed", "effect-committed", "result-committed"]
)
async def test_lost_receipts_retry_without_repeating_effect(
    database_url: str, async_psycopg_pool: Any, boundary: str
) -> None:
    task_id = enqueue(database_url)
    failures = []

    async def crash(observed: str, _writer: Any) -> None:
        if observed == boundary and not failures:
            failures.append(observed)
            raise RuntimeError(f"Lost receipt after {observed}")

    running = worker(database_url, async_psycopg_pool, hook=crash)
    assert await running.run_once()
    initial = row(database_url, task_id)
    if boundary == "history-committed":
        with pytest.raises(recipe.RecipeRejected, match="registered/committed"):
            await recipe.complete_decision(database_url, task_id, True, actor="local-reviewer")
        promote(database_url)
        assert await running.run_once()
        assert row(database_url, task_id)["history"] == initial["history"]
    assert (
        await recipe.complete_decision(database_url, task_id, True, actor="local-reviewer")
        == "completed"
    )
    assert await running.run_once()
    if boundary != "history-committed":
        assert outcome(database_url, task_id) is None
        assert credit(database_url) == (
            7 if boundary in {"effect-committed", "result-committed"} else 0
        )
        promote(database_url)
        assert await running.run_once()
    assert failures == [boundary]
    assert credit(database_url) == 7
    assert outcome(database_url, task_id)[0] == "succeeded"
    with psycopg.connect(database_url) as connection:
        assert connection.execute("SELECT count(*) FROM pydanticai_effect").fetchone() == (1,)


@pytest.mark.parametrize(
    "tamper",
    [
        "version",
        "history",
        "conversation",
        "call-id",
        "args",
        "request",
        "budget",
        "effect-conflict",
    ],
)
async def test_retention_and_identity_fail_closed(
    database_url: str, async_psycopg_pool: Any, tamper: str
) -> None:
    task_id = enqueue(database_url, EnqueueOptions(max_attempts=1))
    running = worker(database_url, async_psycopg_pool)
    assert await running.run_once()
    assert (
        await recipe.complete_decision(database_url, task_id, True, actor="local-reviewer")
        == "completed"
    )
    with psycopg.connect(database_url) as connection:
        if tamper == "version":
            connection.execute("UPDATE pydanticai_conversation SET framework_version = 'different'")
        elif tamper == "history":
            connection.execute("UPDATE pydanticai_conversation SET history = NULL")
        elif tamper == "conversation":
            connection.execute("DELETE FROM pydanticai_conversation")
        elif tamper == "budget":
            connection.execute(
                "UPDATE pydanticai_conversation SET requests = %s", (recipe.MAX_REQUESTS,)
            )
        elif tamper == "effect-conflict":
            connection.execute(
                "INSERT INTO pydanticai_effect VALUES (%s, %s, %s)",
                (task_id, recipe.TOOL_CALL_ID, Jsonb({"account": "account-a", "amount": 99})),
            )
        else:
            pending = row(database_url, task_id)["pending"]
            if tamper == "call-id":
                pending["tool_call_id"] = "fabricated"
            elif tamper == "args":
                pending["args"]["amount"] = 99
            else:
                connection.execute(
                    "UPDATE pydanticai_conversation SET request = %s",
                    (Jsonb({"account": "other", "amount": 7}),),
                )
            connection.execute("UPDATE pydanticai_conversation SET pending = %s", (Jsonb(pending),))
    assert await running.run_once()
    assert credit(database_url) == 0
    assert outcome(database_url, task_id)[0] == "failed"


async def test_unauthorized_or_uncommitted_approval(
    database_url: str, async_psycopg_pool: Any
) -> None:
    task_id = enqueue(database_url)
    running = worker(database_url, async_psycopg_pool)
    assert await running.run_once()
    with pytest.raises(recipe.RecipeRejected, match="fixed reviewer"):
        await recipe.complete_decision(database_url, task_id, True, actor="untrusted")
    with psycopg.connect(database_url) as connection:
        Queue(connection).complete_human_wait(
            task_id,
            recipe.WAIT_NAME,
            {"approved": True},
            idempotency_key="rolled-back",
            requested_by="local-reviewer",
        )
        connection.rollback()
    assert not await running.run_once()
    assert row(database_url, task_id)["decision"] is None
    assert credit(database_url) == 0


@pytest.mark.parametrize("terminal", ["cancellation", "deadline", "wait-timeout"])
async def test_suspended_terminal_observer_preserves_context(
    database_url: str, async_psycopg_pool: Any, terminal: str
) -> None:
    task_id = enqueue(
        database_url,
        EnqueueOptions(max_attempts=1, deadline=datetime.now(UTC) + timedelta(minutes=1)),
    )
    running = worker(
        database_url,
        async_psycopg_pool,
        wait_ms=10 if terminal == "wait-timeout" else recipe.WAIT_MS,
    )
    assert await running.run_once()
    initial = row(database_url, task_id)
    if terminal == "wait-timeout":
        await asyncio.sleep(0.03)
    with psycopg.connect(database_url, autocommit=True) as connection:
        if terminal == "cancellation":
            assert Queue(connection).cancel(task_id).status == "canceled"
        elif terminal == "deadline":
            connection.execute(
                "UPDATE workhorse.task_runtime "
                "SET deadline_at = clock_timestamp() - interval '1 second' "
                "WHERE task_id = %s",
                (task_id,),
            )
        connection.execute("SELECT * FROM workhorse.tick_v1(100, 100)")
    await running.run_once()
    assert await recipe.reconcile_terminal(database_url, task_id) in {"failed", "canceled"}
    stopped = row(database_url, task_id)
    assert stopped["history"] == initial["history"]
    assert stopped["pending"] == initial["pending"]
    assert credit(database_url) == 0
    with pytest.raises(recipe.RecipeRejected, match="stopped"):
        await recipe.complete_decision(database_url, task_id, True, actor="local-reviewer")


async def test_cancel_after_committed_effect_does_not_undo_credit(
    database_url: str, async_psycopg_pool: Any
) -> None:
    task_id = enqueue(database_url)

    async def crash(boundary: str, _writer: Any) -> None:
        if boundary == "effect-committed":
            raise RuntimeError("Receipt lost")

    running = worker(database_url, async_psycopg_pool, hook=crash)
    assert await running.run_once()
    await recipe.complete_decision(database_url, task_id, True, actor="local-reviewer")
    assert await running.run_once()
    assert credit(database_url) == 7
    with psycopg.connect(database_url) as connection:
        assert Queue(connection).cancel(task_id).status == "canceled"
    assert await recipe.reconcile_terminal(database_url, task_id) == "canceled"
    assert credit(database_url) == 7


async def test_concurrent_driver_lock_and_lost_writer_session(
    database_url: str, async_psycopg_pool: Any
) -> None:
    task_id = enqueue(database_url, EnqueueOptions(max_attempts=1))
    await worker(database_url, async_psycopg_pool).run_once()
    async with (
        recipe.exclusive_writer(database_url, task_id) as first,
        await psycopg.AsyncConnection.connect(database_url, autocommit=True) as observer,
    ):
        with pytest.raises(recipe.RecipeRejected, match="Another application driver"):
            async with recipe.exclusive_writer(database_url, task_id):
                pytest.fail("second driver entered")
        assert first.info.backend_pid != observer.info.backend_pid
        await observer.execute("SELECT pg_terminate_backend(%s)", (first.info.backend_pid,))
        with pytest.raises(psycopg.OperationalError):
            await first.execute("UPDATE pydanticai_conversation SET decision = true")
        async with recipe.exclusive_writer(database_url, task_id) as replacement:
            await recipe.read_conversation(replacement, task_id)
    assert row(database_url, task_id)["decision"] is None
    assert credit(database_url) == 0


async def test_stale_driver_fenced_before_effect(
    database_url: str, async_psycopg_pool: Any
) -> None:
    task_id = enqueue(database_url)
    captured = []

    async def stale(boundary: str, writer_connection: Any) -> None:
        if boundary == "decision-committed":
            captured.append(writer_connection.info.backend_pid)
            with psycopg.connect(database_url, autocommit=True) as connection:
                connection.execute(
                    "UPDATE workhorse.task_runtime SET fence_token = fence_token + 1 "
                    "WHERE task_id = %s",
                    (task_id,),
                )

    running = worker(database_url, async_psycopg_pool, hook=stale)
    assert await running.run_once()
    await recipe.complete_decision(database_url, task_id, True, actor="local-reviewer")
    assert await running.run_once()
    assert captured
    assert credit(database_url) == 0
    assert row(database_url, task_id)["result"] is None


async def test_fresh_interpreter_resume_after_effect_commit_process_exit(
    database_url: str, async_psycopg_pool: Any
) -> None:
    task_id = enqueue(database_url)
    assert await worker(database_url, async_psycopg_pool).run_once()
    await recipe.complete_decision(database_url, task_id, True, actor="local-reviewer")
    script = """
import asyncio, importlib.util, os, sys
from psycopg_pool import AsyncConnectionPool
from workhorse import AsyncWorker
spec = importlib.util.spec_from_file_location('recipe', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
async def hook(boundary, writer):
    if boundary == 'effect-committed': os._exit(73)
async def run():
    async with AsyncConnectionPool(
        sys.argv[2], min_size=3, max_size=3, kwargs={'autocommit':True}, open=False
    ) as pool:
        worker = AsyncWorker.from_psycopg(pool).handle(
            module.TASK_TYPE, module.make_handler(sys.argv[2],hook=hook)
        )
        await worker.run_once()
asyncio.run(run())
"""
    exited = await asyncio.to_thread(
        subprocess.run,
        [sys.executable, "-c", script, str(EXAMPLE), database_url],
        capture_output=True,
        text=True,
        check=False,
    )
    assert exited.returncode == 73, exited.stderr
    assert credit(database_url) == 7
    assert row(database_url, task_id)["result"] is None
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute(
            "UPDATE workhorse.task_runtime "
            "SET expires_at = clock_timestamp() - interval '1 second' "
            "WHERE task_id = %s",
            (task_id,),
        )
        connection.execute("SELECT * FROM workhorse.tick_v1(100, 100)")
    promote(database_url)
    resumed = await asyncio.to_thread(
        subprocess.run,
        [
            sys.executable,
            "-c",
            script.replace("if boundary == 'effect-committed': os._exit(73)", "return None"),
            str(EXAMPLE),
            database_url,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert resumed.returncode == 0, resumed.stderr
    assert credit(database_url) == 7
    assert outcome(database_url, task_id)[0] == "succeeded"


@pytest.mark.parametrize("repair", [True, False])
async def test_native_model_retry_is_bounded_not_a_task_retry(repair: bool) -> None:
    calls = []

    def respond(messages: Any, _info: Any) -> ModelResponse:
        parts = [part for message in messages for part in message.parts]
        if any(isinstance(part, ToolReturnPart) for part in parts):
            return ModelResponse(parts=[TextPart("repaired")])
        amount = 7 if repair and any(isinstance(part, RetryPromptPart) for part in parts) else -1
        return ModelResponse(
            parts=[ToolCallPart("credit", {"amount": amount}, tool_call_id="repair")]
        )

    agent = Agent(FunctionModel(respond), retries=1)

    @agent.tool_plain
    def credit(amount: int) -> str:
        calls.append(amount)
        if amount < 0:
            raise ModelRetry("Use a positive amount")
        return "ok"

    agent = Agent(FunctionModel(respond), retries=1, tools=[credit])
    if repair:
        assert (await agent.run("repair")).output == "repaired"
        assert calls == [-1, 7]
    else:
        with pytest.raises(UnexpectedModelBehavior):
            await agent.run("repair")
        assert calls == [-1, -1]


async def test_approved_model_repair_needs_new_approval_and_new_run_id() -> None:
    def respond(messages: Any, _info: Any) -> ModelResponse:
        repaired = any(
            isinstance(part, RetryPromptPart) for message in messages for part in message.parts
        )
        return ModelResponse(
            parts=[
                ToolCallPart("credit", {"amount": 7 if repaired else -1}, tool_call_id="same-id")
            ]
        )

    agent: Agent[None, str | DeferredToolRequests] = Agent(
        FunctionModel(respond), output_type=str | DeferredToolRequests, retries=1
    )

    @agent.tool_plain(requires_approval=True)
    def credit(amount: int) -> str:
        raise ModelRetry(f"repair {amount}")

    initial = await agent.run("review")
    assert isinstance(initial.output, DeferredToolRequests)
    history = ModelMessagesTypeAdapter.validate_json(
        ModelMessagesTypeAdapter.dump_json(initial.all_messages())
    )
    with pytest.raises(UserError, match="run_id"):
        await agent.run(
            message_history=history,
            run_id=initial.run_id,
            deferred_tool_results=initial.output.build_results(approve_all=True),
        )
    repaired = await agent.run(
        message_history=history,
        deferred_tool_results=initial.output.build_results(approve_all=True),
    )
    assert isinstance(repaired.output, DeferredToolRequests)
    assert repaired.output.approvals[0].args_as_dict() == {"amount": 7}
    assert repaired.output.approvals[0].tool_call_id == "same-id"
    assert initial.run_id != repaired.run_id


@pytest.mark.parametrize("native_token", [True, False])
async def test_native_cancellation_contract(native_token: bool) -> None:
    entered = asyncio.Event()

    async def blocked(_messages: Any, _info: Any) -> ModelResponse:
        entered.set()
        await asyncio.Event().wait()
        return ModelResponse(parts=[TextPart("unreachable")])

    token = CancellationToken()
    agent = Agent(FunctionModel(blocked))
    running = asyncio.create_task(agent.run("block", cancellation_token=token))
    await entered.wait()
    if native_token:
        token.cancel()
        with pytest.raises(RunCancelled) as stopped:
            await running
        assert stopped.value.all_messages()
    else:
        running.cancel()
        with pytest.raises(asyncio.CancelledError) as stopped:
            await running
        assert RunCancelled.from_cancellation(stopped.value).all_messages()


async def test_testmodel_inventory_is_allowlisted() -> None:
    agent = Agent(TestModel(call_tools=["safe"]))
    called = []

    @agent.tool_plain
    def safe() -> str:
        called.append("safe")
        return "local"

    assert (await agent.run("test")).output
    assert called == ["safe"]


async def test_concurrent_conflicting_approval_first_decision_wins(
    database_url: str, async_psycopg_pool: Any
) -> None:
    task_id = enqueue(database_url)
    running = worker(database_url, async_psycopg_pool)
    assert await running.run_once()
    results = await asyncio.gather(
        recipe.complete_decision(database_url, task_id, True, actor="local-reviewer"),
        recipe.complete_decision(database_url, task_id, False, actor="local-reviewer"),
        return_exceptions=True,
    )
    assert results.count("completed") == 1
    assert sum(isinstance(result, HumanWaitIdempotencyConflictError) for result in results) == 1
    assert await running.run_once()
    approved = row(database_url, task_id)["decision"]
    assert credit(database_url) == (7 if approved else 0)


async def test_recipe_rejects_native_repaired_deferred_request(
    database_url: str, async_psycopg_pool: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    def repairing_agent(*_args: Any) -> Agent[None, str | DeferredToolRequests]:
        def respond(messages: Any, _info: Any) -> ModelResponse:
            repaired = any(
                isinstance(part, RetryPromptPart) for message in messages for part in message.parts
            )
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "credit",
                        {"account": "account-a", "amount": 8 if repaired else 7},
                        tool_call_id=recipe.TOOL_CALL_ID,
                    )
                ]
            )

        agent: Agent[None, str | DeferredToolRequests] = Agent(
            FunctionModel(respond), output_type=str | DeferredToolRequests, retries=1
        )

        @agent.tool_plain(requires_approval=True)
        def credit(account: str, amount: int) -> str:
            raise ModelRetry(f"Repair {account}/{amount}")

        return agent

    monkeypatch.setattr(recipe, "build_agent", repairing_agent)
    task_id = enqueue(database_url, EnqueueOptions(max_attempts=1))
    running = worker(database_url, async_psycopg_pool)
    assert await running.run_once()
    await recipe.complete_decision(database_url, task_id, True, actor="local-reviewer")
    assert await running.run_once()
    assert outcome(database_url, task_id)[0] == "failed"
    assert "separate approval recipe" in json.dumps(outcome(database_url, task_id)[2])
    assert credit(database_url) == 0
    assert row(database_url, task_id)["pending"]["args"] == REQUEST


@pytest.mark.parametrize("stop", ["cancel", "execution-timeout"])
async def test_active_framework_run_stops_with_queue_authority(
    database_url: str, async_psycopg_pool: Any, stop: str
) -> None:
    task_id = enqueue(
        database_url,
        EnqueueOptions(
            max_attempts=1, execution_timeout_ms=100 if stop == "execution-timeout" else None
        ),
    )
    entered = asyncio.Event()
    canceled = asyncio.Event()

    async def blocking(boundary: str, _writer: Any) -> None:
        if boundary == "model-enter":
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                canceled.set()
                raise

    running = AsyncWorker.from_psycopg(async_psycopg_pool, heartbeat_ms=10).handle(
        recipe.TASK_TYPE, recipe.make_handler(database_url, hook=blocking)
    )
    activation = asyncio.create_task(running.run_once())
    await asyncio.wait_for(entered.wait(), timeout=5)
    if stop == "cancel":
        with psycopg.connect(database_url) as connection:
            assert Queue(connection).cancel(task_id).status == "cancel_requested"
    assert await asyncio.wait_for(activation, timeout=5)
    assert canceled.is_set()
    assert outcome(database_url, task_id)[0] == ("canceled" if stop == "cancel" else "failed")
    assert credit(database_url) == 0
    assert await recipe.reconcile_terminal(database_url, task_id) in {"canceled", "failed"}


async def test_writer_loss_between_approval_and_tool_prevents_effect(
    database_url: str, async_psycopg_pool: Any
) -> None:
    task_id = enqueue(database_url, EnqueueOptions(max_attempts=1))

    async def terminate(boundary: str, writer_connection: Any) -> None:
        if boundary == "decision-committed":
            with psycopg.connect(database_url, autocommit=True) as connection:
                connection.execute(
                    "SELECT pg_terminate_backend(%s)", (writer_connection.info.backend_pid,)
                )

    running = worker(database_url, async_psycopg_pool, hook=terminate)
    assert await running.run_once()
    await recipe.complete_decision(database_url, task_id, True, actor="local-reviewer")
    assert await running.run_once()
    assert outcome(database_url, task_id)[0] == "failed"
    assert credit(database_url) == 0


async def test_effect_and_operation_ledger_roll_back_together(
    database_url: str, async_psycopg_pool: Any
) -> None:
    task_id = enqueue(database_url, EnqueueOptions(max_attempts=1))
    with psycopg.connect(database_url) as connection:
        connection.execute(
            "ALTER TABLE pydanticai_account ADD CONSTRAINT reject_credit CHECK (credit < 7)"
        )
    running = worker(database_url, async_psycopg_pool)
    assert await running.run_once()
    await recipe.complete_decision(database_url, task_id, True, actor="local-reviewer")
    assert await running.run_once()
    assert outcome(database_url, task_id)[0] == "failed"
    assert credit(database_url) == 0
    with psycopg.connect(database_url) as connection:
        assert connection.execute("SELECT count(*) FROM pydanticai_effect").fetchone() == (0,)


async def test_lost_model_turns_consume_the_retained_conversation_budget(
    database_url: str, async_psycopg_pool: Any
) -> None:
    task_id = enqueue(database_url, EnqueueOptions(max_attempts=5))
    requests = []

    async def lose_turn(boundary: str, _writer: Any) -> None:
        if boundary == "model-enter":
            requests.append(boundary)
            raise RuntimeError("Model turn receipt lost")

    running = worker(database_url, async_psycopg_pool, hook=lose_turn)
    for expected in range(1, recipe.MAX_REQUESTS + 1):
        assert await running.run_once()
        assert row(database_url, task_id)["requests"] == expected
        assert row(database_url, task_id)["history"] is None
        promote(database_url)
    assert await running.run_once()
    assert len(requests) == recipe.MAX_REQUESTS
    assert credit(database_url) == 0
    assert outcome(database_url, task_id)[0] == "failed"
    assert "budget exhausted" in json.dumps(outcome(database_url, task_id)[2])


async def test_queue_decision_cannot_supply_client_history_or_tool_arguments(
    database_url: str, async_psycopg_pool: Any
) -> None:
    task_id = enqueue(database_url, EnqueueOptions(max_attempts=1))
    running = worker(database_url, async_psycopg_pool)
    assert await running.run_once()
    initial = row(database_url, task_id)
    with psycopg.connect(database_url) as connection:
        Queue(connection).complete_human_wait(
            task_id,
            recipe.WAIT_NAME,
            {"approved": True, "history": "client-fabricated", "amount": 99},
            idempotency_key="malformed-decision",
            requested_by="client",
        )
    assert await running.run_once()
    assert outcome(database_url, task_id)[0] == "failed"
    assert row(database_url, task_id)["history"] == initial["history"]
    assert row(database_url, task_id)["decision"] is None
    assert credit(database_url) == 0


async def test_missing_conversation_before_first_bridge_receipt_is_not_recreated(
    database_url: str, async_psycopg_pool: Any
) -> None:
    task_id = enqueue(database_url, EnqueueOptions(max_attempts=2))

    async def lose_history(boundary: str, writer_connection: Any) -> None:
        if boundary == "history-committed":
            await writer_connection.execute("DELETE FROM pydanticai_conversation")
            raise RuntimeError("Application row lost before bridge receipt")

    running = worker(database_url, async_psycopg_pool, hook=lose_history)
    assert await running.run_once()
    promote(database_url)
    assert await running.run_once()
    assert outcome(database_url, task_id)[0] == "failed"
    assert "Missing retained application conversation" in json.dumps(
        outcome(database_url, task_id)[2]
    )
    assert credit(database_url) == 0
    with psycopg.connect(database_url) as connection:
        assert connection.execute("SELECT count(*) FROM pydanticai_conversation").fetchone() == (0,)


async def test_admission_owns_one_caller_transaction_and_rolls_back_together(
    database_url: str,
) -> None:
    with psycopg.connect(database_url) as setup:
        setup.execute(recipe.DDL)
    async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as connection:
        with pytest.raises(recipe.RecipeRejected, match="explicit caller transaction"):
            await recipe.admit(connection, REQUEST)
        with pytest.raises(RuntimeError, match="roll back admission"):
            async with connection.transaction():
                task_id = await recipe.admit(connection, REQUEST)
                with psycopg.connect(database_url) as observer:
                    assert observer.execute(
                        "SELECT count(*) FROM workhorse.task WHERE id = %s", (task_id,)
                    ).fetchone() == (0,)
                    assert observer.execute(
                        "SELECT count(*) FROM pydanticai_conversation"
                    ).fetchone() == (0,)
                raise RuntimeError("roll back admission")
        async with connection.transaction():
            committed = await recipe.admit(connection, REQUEST)
    with psycopg.connect(database_url) as observer:
        assert observer.execute("SELECT count(*) FROM workhorse.task").fetchone() == (1,)
        assert observer.execute("SELECT task_id FROM pydanticai_conversation").fetchone() == (
            UUID(committed),
        )
