from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextvars import ContextVar

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from test_async_checkpoint_cancellation import SyncCheckpoints

from workhorse import Json
from workhorse.async_worker import _AsyncCheckpointAdapter, _BridgeThreads

REQUEST: ContextVar[str] = ContextVar("request", default="unset")


async def finished(value: Json) -> Json:
    await asyncio.sleep(0)
    return value


def factory_returning_a_task() -> Awaitable[Json]:
    return asyncio.ensure_future(finished("task"))


def factory_returning_a_loop_future() -> Awaitable[Json]:
    future = asyncio.get_running_loop().create_future()
    asyncio.get_running_loop().call_soon(future.set_result, "future")
    return future


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("factory", "expected"),
    [(factory_returning_a_task, "task"), (factory_returning_a_loop_future, "future")],
)
async def test_a_synchronous_factory_may_create_its_operation_on_the_loop(
    factory: Callable[[], Awaitable[Json]], expected: Json
) -> None:
    threads = _BridgeThreads()
    context = SyncCheckpoints()
    adapter = _AsyncCheckpointAdapter(context, asyncio.get_running_loop(), threads)
    try:
        assert await adapter.checkpoint("loop", factory) == expected
        assert context.saved == [expected]
    finally:
        threads.close()


@pytest.mark.asyncio
async def test_a_checkpoint_operation_sees_the_handler_context_variables() -> None:
    threads = _BridgeThreads()
    adapter = _AsyncCheckpointAdapter(SyncCheckpoints(), asyncio.get_running_loop(), threads)

    async def inner() -> Json:
        return REQUEST.get()

    async def outer() -> Json:
        seen = REQUEST.get()
        REQUEST.set("changed by the operation")
        nested = await adapter.checkpoint("inner", inner)
        return [seen, nested]

    try:
        REQUEST.set("handler")
        assert await adapter.checkpoint("outer", outer) == ["handler", "changed by the operation"]
        # Like a task, the operation runs in a copy, so its changes stay inside it.
        assert REQUEST.get() == "handler"
    finally:
        threads.close()


@pytest.mark.asyncio
async def test_concurrent_handlers_keep_their_own_checkpoint_context() -> None:
    threads = _BridgeThreads()
    adapter = _AsyncCheckpointAdapter(SyncCheckpoints(), asyncio.get_running_loop(), threads)
    both_started = asyncio.Barrier(2)

    async def handler(name: str) -> Json:
        REQUEST.set(name)

        async def operation() -> Json:
            await both_started.wait()
            return REQUEST.get()

        return await adapter.checkpoint(name, operation)

    try:
        assert await asyncio.gather(handler("first"), handler("second")) == ["first", "second"]
    finally:
        threads.close()


@pytest.mark.asyncio
async def test_a_span_started_in_a_checkpoint_operation_is_a_child_of_the_handler_span() -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("checkpoint-context")
    threads = _BridgeThreads()
    adapter = _AsyncCheckpointAdapter(SyncCheckpoints(), asyncio.get_running_loop(), threads)

    async def operation() -> Json:
        with tracer.start_as_current_span("operation"):
            return "traced"

    try:
        with tracer.start_as_current_span("handler") as handler_span:
            await adapter.checkpoint("traced", operation)
    finally:
        threads.close()
        provider.shutdown()

    (span,) = (span for span in exporter.get_finished_spans() if span.name == "operation")
    assert span.parent is not None
    assert span.parent.span_id == handler_span.get_span_context().span_id
