"""Resumes one deferred PydanticAI tool from retained message history after a Workhorse human
decision, without replacing PydanticAI's execution model.

Documentation: https://workhorse.run/docs/pydanticai
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import json
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import psycopg
from psycopg.pq import TransactionStatus
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool
from pydantic_ai import (
    Agent,
    CancellationToken,
    DeferredToolRequests,
    RunCancelled,
    RunContext,
    models as ai_models,
)
from pydantic_ai.messages import (
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.usage import RunUsage, UsageLimits

from workhorse import AsyncAdmin, AsyncHandlerContext, AsyncQueue, AsyncWorker, EnqueueOptions, Json

ai_models.ALLOW_MODEL_REQUESTS = False

VERSION = "2.53.0"
RECIPE = "local-credit-v1"
TASK_TYPE = "pydanticai.credit"
WAIT_NAME = "credit-approval"
TOOL_CALL_ID = "credit-1"
WAIT_MS = 60_000
MAX_REQUESTS = 4
MAX_HISTORY_BYTES = 32_768
DDL = """
CREATE TABLE IF NOT EXISTS pydanticai_conversation (
    task_id uuid PRIMARY KEY,
    recipe text NOT NULL,
    framework_version text NOT NULL,
    request jsonb NOT NULL,
    history text,
    result_history text,
    pending jsonb,
    decision boolean,
    result text,
    stopped text,
    requests integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pydanticai_effect (
    task_id uuid NOT NULL,
    tool_call_id text NOT NULL,
    arguments jsonb NOT NULL,
    PRIMARY KEY (task_id, tool_call_id)
);
CREATE TABLE IF NOT EXISTS pydanticai_account (
    account text PRIMARY KEY,
    credit bigint NOT NULL DEFAULT 0
);
"""
type Writer = psycopg.AsyncConnection[dict[str, Any]]
type Hook = Callable[[str, Writer], Awaitable[None]]


class RecipeRejected(RuntimeError):
    pass


async def no_hook(_boundary: str, _writer: Writer) -> None:
    return None


def validate_request(payload: Json) -> dict[str, Json]:
    if not isinstance(payload, dict) or set(payload) != {"account", "amount"}:
        raise RecipeRejected("Only server-admitted account and amount are accepted")
    account, amount = payload["account"], payload["amount"]
    if not isinstance(account, str) or not account or len(account) > 80:
        raise RecipeRejected("Invalid local account")
    if type(amount) is not int or not 0 < amount <= 100:
        raise RecipeRejected("Invalid local credit amount")
    return {"account": account, "amount": amount}


def lock_key(task_id: str) -> int:
    return int.from_bytes(hashlib.sha256(task_id.encode()).digest()[:8], "big", signed=True)


async def admit(
    connection: psycopg.AsyncConnection[Any],
    payload: Json,
    options: EnqueueOptions | None = None,
) -> str:
    request = validate_request(payload)
    if connection.info.transaction_status != TransactionStatus.INTRANS:
        raise RecipeRejected("Admission requires an explicit caller transaction")
    task_id = await AsyncQueue.from_psycopg(connection).enqueue(TASK_TYPE, request, options)
    await connection.execute(
        "INSERT INTO pydanticai_conversation (task_id, recipe, framework_version, request) "
        "VALUES (%s, %s, %s, %s)",
        (task_id, RECIPE, VERSION, Jsonb(request)),
    )
    return task_id


@asynccontextmanager
async def exclusive_writer(database_url: str, task_id: str) -> AsyncIterator[Writer]:
    async with await psycopg.AsyncConnection.connect(
        database_url, autocommit=True, row_factory=dict_row
    ) as writer:
        cursor = await writer.execute(
            "SELECT pg_try_advisory_lock(%s) AS acquired", (lock_key(task_id),)
        )
        row = await cursor.fetchone()
        if row is None or not row["acquired"]:
            raise RecipeRejected("Another application driver owns this conversation")
        yield writer


async def read_conversation(writer: Writer, task_id: str) -> dict[str, Any]:
    cursor = await writer.execute(
        "SELECT * FROM pydanticai_conversation WHERE task_id = %s", (task_id,)
    )
    row = await cursor.fetchone()
    if row is None:
        raise RecipeRejected("Missing retained application conversation")
    if row["recipe"] != RECIPE or row["framework_version"] != VERSION:
        raise RecipeRejected("History requires an explicit recipe/serializer migration")
    if row["stopped"] is not None:
        raise RecipeRejected("Conversation has stopped")
    return row


def decode_pending(row: dict[str, Any]) -> tuple[list[ModelMessage], DeferredToolRequests]:
    history = row["history"]
    if not isinstance(history, str) or len(history.encode()) > MAX_HISTORY_BYTES:
        raise RecipeRejected("Missing or oversized retained history")
    messages = ModelMessagesTypeAdapter.validate_json(history)
    pending = row["pending"]
    if pending != {"tool_name": "credit", "tool_call_id": TOOL_CALL_ID, "args": row["request"]}:
        raise RecipeRejected("Pending call does not match admitted server request")
    if not messages or not isinstance(messages[-1], ModelResponse):
        raise RecipeRejected("History has no deferred response")
    parts = messages[-1].parts
    if len(parts) != 1 or not isinstance(parts[0], ToolCallPart):
        raise RecipeRejected("Exactly one deferred local tool is required")
    call = parts[0]
    if (
        call.tool_name != pending["tool_name"]
        or call.tool_call_id != pending["tool_call_id"]
        or call.args_as_dict() != pending["args"]
    ):
        raise RecipeRejected("Retained history and approval identity disagree")
    return messages, DeferredToolRequests(approvals=[call])


async def fence(context: AsyncHandlerContext) -> None:
    context.cancellation.raise_if_cancelled()
    await context.set_progress({"conversation": context.task.id, "recipe": RECIPE})


async def local_credit(
    writer: Writer,
    context: AsyncHandlerContext,
    tool_call_id: str,
    arguments: dict[str, Json],
    hook: Hook = no_hook,
) -> str:
    row = await read_conversation(writer, context.task.id)
    decode_pending(row)
    if row["decision"] is not True or arguments != row["request"] or tool_call_id != TOOL_CALL_ID:
        raise RecipeRejected("Tool execution is not covered by the retained approval")
    await fence(context)
    async with writer.transaction():
        cursor = await writer.execute(
            "INSERT INTO pydanticai_effect VALUES (%s, %s, %s) "
            "ON CONFLICT DO NOTHING RETURNING tool_call_id",
            (context.task.id, tool_call_id, Jsonb(arguments)),
        )
        inserted = await cursor.fetchone()
        cursor = await writer.execute(
            "SELECT arguments FROM pydanticai_effect WHERE task_id = %s AND tool_call_id = %s",
            (context.task.id, tool_call_id),
        )
        effect = await cursor.fetchone()
        if effect is None or effect["arguments"] != arguments:
            raise RecipeRejected("Operation key reused with conflicting arguments")
        if inserted is not None:
            await writer.execute(
                "INSERT INTO pydanticai_account VALUES (%s, %s) ON CONFLICT (account) "
                "DO UPDATE SET credit = pydanticai_account.credit + EXCLUDED.credit",
                (arguments["account"], arguments["amount"]),
            )
    await hook("effect-committed", writer)
    return "Local credit recorded"


def build_agent(
    request: dict[str, Json], writer: Writer, context: AsyncHandlerContext, hook: Hook
) -> Agent[None, str | DeferredToolRequests]:
    async def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        if [tool.name for tool in info.function_tools] != ["credit"]:
            raise RecipeRejected("Unexpected tool inventory")
        await fence(context)
        cursor = await writer.execute(
            "UPDATE pydanticai_conversation SET requests = requests + 1 "
            "WHERE task_id = %s AND requests < %s RETURNING requests",
            (context.task.id, MAX_REQUESTS),
        )
        if await cursor.fetchone() is None:
            raise RecipeRejected("Conversation request budget exhausted, including lost turns")
        await hook("model-enter", writer)
        if any(isinstance(part, ToolReturnPart) for message in messages for part in message.parts):
            return ModelResponse(parts=[TextPart("Reviewed local credit")])
        return ModelResponse(parts=[ToolCallPart("credit", request, tool_call_id=TOOL_CALL_ID)])

    agent: Agent[None, str | DeferredToolRequests] = Agent(
        FunctionModel(respond), output_type=[str, DeferredToolRequests], retries=1
    )

    @agent.tool(requires_approval=True)
    async def credit(run: RunContext[None], account: str, amount: int) -> str:
        if run.tool_call_id is None:
            raise RecipeRejected("Missing native tool identity")
        return await local_credit(
            writer, context, run.tool_call_id, {"account": account, "amount": amount}, hook
        )

    return agent


async def run_turn(
    agent: Agent[None, str | DeferredToolRequests],
    writer: Writer,
    context: AsyncHandlerContext,
    row: dict[str, Any],
) -> tuple[str | DeferredToolRequests, str, int]:
    await fence(context)
    if row["requests"] >= MAX_REQUESTS:
        raise RecipeRejected("Conversation request budget exhausted before tool execution")
    token = CancellationToken()

    async def relay() -> None:
        await context.cancellation.wait()
        token.cancel()

    relay_task = asyncio.create_task(relay())
    usage = RunUsage(requests=row["requests"])
    try:
        if row["history"] is None:
            result = await agent.run(
                "Review the server-admitted local credit",
                conversation_id=context.task.id,
                cancellation_token=token,
                usage=usage,
                usage_limits=UsageLimits(request_limit=MAX_REQUESTS),
            )
        else:
            messages, pending = decode_pending(row)
            if type(row["decision"]) is not bool:
                raise RecipeRejected("Approval must commit before a new Agent turn")
            result = await agent.run(
                message_history=messages,
                deferred_tool_results=pending.build_results(
                    approvals={TOOL_CALL_ID: row["decision"]}
                ),
                conversation_id=context.task.id,
                cancellation_token=token,
                usage=usage,
                usage_limits=UsageLimits(request_limit=MAX_REQUESTS),
            )
        history = ModelMessagesTypeAdapter.dump_json(result.all_messages()).decode()
        if len(history.encode()) > MAX_HISTORY_BYTES:
            raise RecipeRejected("History exceeded the application retention bound")
        retained = await read_conversation(writer, context.task.id)
        return result.output, history, retained["requests"]
    except RunCancelled:
        context.cancellation.raise_if_cancelled()
        raise
    finally:
        relay_task.cancel()
        with suppress(asyncio.CancelledError):
            await relay_task


def make_handler(
    database_url: str, *, hook: Hook = no_hook, wait_ms: int = WAIT_MS
) -> Callable[[Json, AsyncHandlerContext], Awaitable[Json]]:
    async def handler(payload: Json, context: AsyncHandlerContext) -> Json:
        request = validate_request(payload)
        if importlib.metadata.version("pydantic-ai-slim") != VERSION:
            raise RecipeRejected("Use the verified exact example dependency")
        async with exclusive_writer(database_url, context.task.id) as writer:
            await fence(context)
            row = await read_conversation(writer, context.task.id)
            if row["request"] != request:
                raise RecipeRejected("Conversation input changed")
            if row["history"] is None and (
                row["pending"] is not None or row["decision"] is not None
            ):
                raise RecipeRejected("Deferred conversation lost its retained history")
            if row["result"] is not None:
                if not isinstance(row["result"], str):
                    raise RecipeRejected("Invalid retained result")
                await context.checkpoint("agent-result-receipt", lambda: receipt(context.task.id))
                return row["result"]
            agent = build_agent(request, writer, context, hook)
            if row["history"] is None:
                output, history, requests = await run_turn(agent, writer, context, row)
                if (
                    not isinstance(output, DeferredToolRequests)
                    or output.calls
                    or len(output.approvals) != 1
                ):
                    raise RecipeRejected("One deferred approval is required")
                call = output.approvals[0]
                pending = {
                    "tool_name": call.tool_name,
                    "tool_call_id": call.tool_call_id,
                    "args": call.args_as_dict(),
                }
                await fence(context)
                await writer.execute(
                    "UPDATE pydanticai_conversation SET history = %s, pending = %s, requests = %s "
                    "WHERE task_id = %s",
                    (history, Jsonb(pending), requests, context.task.id),
                )
                await hook("history-committed", writer)
                row = await read_conversation(writer, context.task.id)
            decode_pending(row)
            await context.checkpoint("agent-history-receipt", lambda: receipt(context.task.id))
            decision = await context.wait_for_human(WAIT_NAME, row["pending"], timeout_ms=wait_ms)
            if (
                not isinstance(decision, dict)
                or set(decision) != {"approved"}
                or type(decision["approved"]) is not bool
            ):
                raise RecipeRejected("Only the authorized boolean decision is accepted")
            await fence(context)
            if row["decision"] is not None and row["decision"] != decision["approved"]:
                raise RecipeRejected("Decision conflict")
            await writer.execute(
                "UPDATE pydanticai_conversation SET decision = %s WHERE task_id = %s",
                (decision["approved"], context.task.id),
            )
            await hook("decision-committed", writer)
            row = await read_conversation(writer, context.task.id)
            output, history, requests = await run_turn(agent, writer, context, row)
            if not isinstance(output, str):
                raise RecipeRejected("A repaired/new tool request needs a separate approval recipe")
            await fence(context)
            await writer.execute(
                "UPDATE pydanticai_conversation SET result_history = %s, result = %s, "
                "requests = %s "
                "WHERE task_id = %s",
                (history, output, requests, context.task.id),
            )
            await hook("result-committed", writer)
            await context.checkpoint("agent-result-receipt", lambda: receipt(context.task.id))
            return output

    return handler


async def receipt(task_id: str) -> Json:
    return {"conversation": task_id}


async def complete_decision(database_url: str, task_id: str, approved: bool, *, actor: str) -> str:
    if actor != "local-reviewer" or type(approved) is not bool:
        raise RecipeRejected("The local fixture authorizes only its fixed reviewer")
    async with await psycopg.AsyncConnection.connect(
        database_url, row_factory=dict_row
    ) as connection:
        row = await read_conversation(connection, task_id)
        decode_pending(row)
        cursor = await connection.execute(
            "SELECT context FROM workhorse.task_human_wait WHERE task_id = %s AND token_name = %s",
            (task_id, WAIT_NAME),
        )
        waiting = await cursor.fetchone()
        if waiting is None or waiting["context"] != row["pending"]:
            raise RecipeRejected("Wait is not registered/committed with this server context")
        result = await AsyncQueue.from_psycopg(connection).complete_human_wait(
            task_id,
            WAIT_NAME,
            {"approved": approved},
            idempotency_key=f"{task_id}:{WAIT_NAME}",
            requested_by=actor,
        )
    return result.status


async def reconcile_terminal(database_url: str, task_id: str) -> str | None:
    async with exclusive_writer(database_url, task_id) as writer:
        snapshot = await AsyncAdmin.from_psycopg(writer).get_task(task_id)
        if snapshot is None:
            raise RecipeRejected("Missing queue authority; retain conversation until reconciled")
        if snapshot.state not in {"failed", "canceled"}:
            return None
        await writer.execute(
            "UPDATE pydanticai_conversation SET stopped = %s WHERE task_id = %s",
            (snapshot.state, task_id),
        )
        return snapshot.state


async def demo(database_url: str) -> None:
    async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as connection:
        await connection.execute(DDL)
        async with connection.transaction():
            task_id = await admit(
                connection,
                {"account": "local-account", "amount": 7},
                EnqueueOptions(max_attempts=3),
            )
    async with AsyncConnectionPool(
        database_url, min_size=3, max_size=3, kwargs={"autocommit": True}, open=False
    ) as pool:
        worker = AsyncWorker.from_psycopg(pool).handle(TASK_TYPE, make_handler(database_url))
        assert await worker.run_once()
        assert (
            await complete_decision(database_url, task_id, True, actor="local-reviewer")
            == "completed"
        )
        assert await worker.run_once()
    async with await psycopg.AsyncConnection.connect(database_url) as connection:
        cursor = await connection.execute(
            "SELECT credit FROM pydanticai_account WHERE account = 'local-account'"
        )
        assert await cursor.fetchone() == (7,)
        cursor = await connection.execute(
            "SELECT state FROM workhorse.task_outcome WHERE task_id = %s", (task_id,)
        )
        assert await cursor.fetchone() == ("succeeded",)
    print(json.dumps({"task": task_id, "local_credit": 7, "framework": VERSION}))


async def main() -> None:
    source = urlsplit(os.environ["DATABASE_URL_TEST"])
    if source.hostname not in {"localhost", "127.0.0.1", "::1"} or "test" not in source.path:
        raise RecipeRejected("Example requires the checkout's loopback test database URL")
    name = f"{source.path[1:40]}_pai_{uuid4().hex[:10]}"
    admin_url = urlunsplit(source._replace(path="/postgres"))
    scratch_url = urlunsplit(source._replace(path=f"/{name}"))
    async with await psycopg.AsyncConnection.connect(admin_url, autocommit=True) as admin:
        await admin.execute(
            psycopg.sql.SQL("CREATE DATABASE {}").format(psycopg.sql.Identifier(name))
        )
    try:
        async with await psycopg.AsyncConnection.connect(
            scratch_url, autocommit=True
        ) as connection:
            await connection.execute(
                (Path(__file__).parents[2] / "sql/schema/current.sql").read_text()
            )
        await demo(scratch_url)
    finally:
        async with await psycopg.AsyncConnection.connect(admin_url, autocommit=True) as admin:
            await admin.execute(
                psycopg.sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                    psycopg.sql.Identifier(name)
                )
            )


if __name__ == "__main__":
    asyncio.run(main())
