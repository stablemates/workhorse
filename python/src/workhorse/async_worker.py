from __future__ import annotations

import asyncio
import inspect
import random
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextlib import suppress
from typing import TYPE_CHECKING, Any, Literal, Protocol, TypeVar, cast

from ._compatibility import AsyncRowExecutor
from ._drivers import (
    AsyncpgConnection,
    AsyncpgExecutor,
    AsyncPsycopgConnection,
    AsyncPsycopgExecutor,
)
from ._statements import DriverStatement
from .types import (
    AsyncBatchHandlerContext,
    AsyncBatchHandlerItem,
    AsyncCancellationToken,
    AsyncHandlerContext,
    BatchHandlerItem,
    BatchHandlerOutcome,
    ChildJobRequest,
    EnqueueOptions,
    HandlerContext,
    JobCheckpoint,
    JobProgress,
    JobWait,
    Json,
)
from .worker import Worker

if TYPE_CHECKING:
    import psycopg

    AsyncPsycopgConnectionInput = psycopg.AsyncConnection[Any]
else:
    AsyncPsycopgConnectionInput = AsyncPsycopgConnection

AsyncHandler = Callable[[Any, AsyncHandlerContext], Awaitable[Json]]
AsyncBatchHandler = Callable[
    [Sequence[AsyncBatchHandlerItem]], Awaitable[Sequence[BatchHandlerOutcome]]
]
AsyncNotificationConnectionFactory = Callable[[], Awaitable[Any]]

_CHANNEL = "workhorse_jobs"
_RECONNECT_INITIAL_SECONDS = 0.1
_RECONNECT_MAX_SECONDS = 5.0
T = TypeVar("T")


async def _await_value(value: Awaitable[T]) -> T:
    return await value


class _AsyncExecutorBridge:
    """Expose an async driver to the shared synchronous lifecycle core."""

    def __init__(self, executor: AsyncRowExecutor) -> None:
        self._executor = executor
        self._loop: asyncio.AbstractEventLoop | None = None
        self._driver_lock: asyncio.Lock | None = None

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._driver_lock = asyncio.Lock()

    def rows(
        self, statement: DriverStatement, parameters: Sequence[object] = ()
    ) -> list[Mapping[str, object]]:
        loop = self._loop
        if loop is None:
            raise RuntimeError("AsyncWorker database access requires an active run call")
        future = asyncio.run_coroutine_threadsafe(self._rows(statement, parameters), loop)
        return future.result()

    async def _rows(
        self, statement: DriverStatement, parameters: Sequence[object]
    ) -> list[Mapping[str, object]]:
        lock = self._driver_lock
        if lock is None:
            raise RuntimeError("AsyncWorker database bridge is not bound")
        async with lock:
            rows = await self._executor.rows(statement, parameters)
        return [dict(row) for row in rows]


class _CheckpointContext(Protocol):
    def get_checkpoint(self, name: str) -> JobCheckpoint | None: ...

    def checkpoint(self, name: str, operation: Callable[[], Json]) -> Json: ...

    def get_progress(self) -> JobProgress | None: ...

    def set_progress(self, value: Json) -> JobProgress: ...


class _AsyncCheckpointAdapter:
    def __init__(self, context: _CheckpointContext, loop: asyncio.AbstractEventLoop) -> None:
        self._checkpoint_context = context
        self._loop = loop

    async def get_checkpoint(self, name: str) -> JobCheckpoint | None:
        return await asyncio.to_thread(self._checkpoint_context.get_checkpoint, name)

    async def checkpoint(self, name: str, operation: Callable[[], Awaitable[Json]]) -> Json:
        def invoke_operation() -> Json:
            return asyncio.run_coroutine_threadsafe(_await_value(operation()), self._loop).result()

        return await asyncio.to_thread(self._checkpoint_context.checkpoint, name, invoke_operation)

    async def get_progress(self) -> JobProgress | None:
        return await asyncio.to_thread(self._checkpoint_context.get_progress)

    async def set_progress(self, value: Json) -> JobProgress:
        return await asyncio.to_thread(self._checkpoint_context.set_progress, value)


class _AsyncContextAdapter(_AsyncCheckpointAdapter):
    def __init__(self, context: HandlerContext, loop: asyncio.AbstractEventLoop) -> None:
        super().__init__(context, loop)
        self._context = context

    def context(self) -> AsyncHandlerContext:
        return AsyncHandlerContext(
            self._context.job,
            AsyncCancellationToken(self._context.cancellation),
            self.get_checkpoint,
            self.get_wait,
            self.get_progress,
            self.set_progress,
            self.checkpoint,
            self.sleep,
            self.sleep_until,
            self.wait_for_signal,
            self.wait_for_human,
            self.run_child,
            self.run_children,
        )

    async def get_wait(self, name: str) -> JobWait | None:
        return await asyncio.to_thread(self._context.get_wait, name)

    async def sleep(self, name: str, duration_ms: int) -> None:
        await asyncio.to_thread(self._context.sleep, name, duration_ms)

    async def sleep_until(self, name: str, wake_at: Any) -> None:
        await asyncio.to_thread(self._context.sleep_until, name, wake_at)

    async def wait_for_signal(self, name: str, timeout_ms: int | None) -> Json:
        return await asyncio.to_thread(self._context.wait_for_signal, name, timeout_ms=timeout_ms)

    async def wait_for_human(self, name: str, context: Json, timeout_ms: int | None) -> Json:
        return await asyncio.to_thread(
            self._context.wait_for_human, name, context, timeout_ms=timeout_ms
        )

    async def run_child(self, name: str, type: str, payload: Json, options: EnqueueOptions) -> Json:
        return await asyncio.to_thread(self._context.run_child, name, type, payload, options)

    async def run_children(self, children: Sequence[ChildJobRequest]) -> dict[str, Json]:
        return await asyncio.to_thread(self._context.run_children, children)


class _AsyncBatchContextAdapter(_AsyncCheckpointAdapter):
    def __init__(self, item: BatchHandlerItem, loop: asyncio.AbstractEventLoop) -> None:
        super().__init__(item.context, loop)
        self._context = item.context
        self.item = AsyncBatchHandlerItem(
            item.payload,
            AsyncBatchHandlerContext(
                item.context.job,
                AsyncCancellationToken(item.context.cancellation),
                self.get_checkpoint,
                self.get_progress,
                self.set_progress,
                self.checkpoint,
            ),
        )


class AsyncWorker:
    """Async handlers over native Psycopg or asyncpg connections and one shared worker core."""

    def __init__(
        self,
        executor: AsyncRowExecutor,
        query_connection: object,
        driver: Literal["psycopg", "asyncpg"],
        *,
        notification_connection_factory: AsyncNotificationConnectionFactory | None = None,
        on_notification_error: Callable[[BaseException], None] | None = None,
        on_registration_error: Callable[[BaseException], None] | None = None,
        **worker_options: Any,
    ) -> None:
        self._bridge = _AsyncExecutorBridge(executor)
        self._query_connection = query_connection
        self._driver = driver
        self._notification_connection_factory = notification_connection_factory
        self._on_notification_error = on_notification_error
        self._loop: asyncio.AbstractEventLoop | None = None
        self._running = False
        self._inner = Worker(
            cast(Any, query_connection),
            on_notification_error=on_notification_error,
            on_registration_error=on_registration_error,
            _executor=self._bridge,
            **worker_options,
        )

    @classmethod
    def from_psycopg(
        cls,
        connection: AsyncPsycopgConnectionInput,
        *,
        queue: str | None = None,
        queues: Sequence[str] | None = None,
        worker_id: str | None = None,
        concurrency: int = 1,
        poll_ms: int | None = None,
        lease_ms: int = 30_000,
        heartbeat_ms: int | None = None,
        maintenance_interval_ms: int = 1_000,
        registry_interval_ms: int = 5_000,
        schedule_namespaces: Sequence[str] = (),
        schedule_catchup_limit: int = 100,
        notification_connection_factory: AsyncNotificationConnectionFactory | None = None,
        on_notification_error: Callable[[BaseException], None] | None = None,
        on_registration_error: Callable[[BaseException], None] | None = None,
    ) -> AsyncWorker:
        if getattr(connection, "autocommit", False) is not True:
            raise ValueError(
                "AsyncWorker requires a dedicated Psycopg connection in autocommit mode"
            )
        return cls(
            AsyncPsycopgExecutor(cast(AsyncPsycopgConnection, connection)),
            connection,
            "psycopg",
            notification_connection_factory=notification_connection_factory,
            on_notification_error=on_notification_error,
            on_registration_error=on_registration_error,
            queue=queue,
            queues=queues,
            worker_id=worker_id,
            concurrency=concurrency,
            poll_ms=poll_ms,
            lease_ms=lease_ms,
            heartbeat_ms=heartbeat_ms,
            maintenance_interval_ms=maintenance_interval_ms,
            registry_interval_ms=registry_interval_ms,
            schedule_namespaces=schedule_namespaces,
            schedule_catchup_limit=schedule_catchup_limit,
        )

    @classmethod
    def from_asyncpg(
        cls,
        connection: AsyncpgConnection,
        *,
        queue: str | None = None,
        queues: Sequence[str] | None = None,
        worker_id: str | None = None,
        concurrency: int = 1,
        poll_ms: int | None = None,
        lease_ms: int = 30_000,
        heartbeat_ms: int | None = None,
        maintenance_interval_ms: int = 1_000,
        registry_interval_ms: int = 5_000,
        schedule_namespaces: Sequence[str] = (),
        schedule_catchup_limit: int = 100,
        notification_connection_factory: AsyncNotificationConnectionFactory | None = None,
        on_notification_error: Callable[[BaseException], None] | None = None,
        on_registration_error: Callable[[BaseException], None] | None = None,
    ) -> AsyncWorker:
        if connection.is_in_transaction():
            raise ValueError("AsyncWorker requires a dedicated asyncpg connection")
        return cls(
            AsyncpgExecutor(connection),
            connection,
            "asyncpg",
            notification_connection_factory=notification_connection_factory,
            on_notification_error=on_notification_error,
            on_registration_error=on_registration_error,
            queue=queue,
            queues=queues,
            worker_id=worker_id,
            concurrency=concurrency,
            poll_ms=poll_ms,
            lease_ms=lease_ms,
            heartbeat_ms=heartbeat_ms,
            maintenance_interval_ms=maintenance_interval_ms,
            registry_interval_ms=registry_interval_ms,
            schedule_namespaces=schedule_namespaces,
            schedule_catchup_limit=schedule_catchup_limit,
        )

    @property
    def queues(self) -> tuple[str, ...]:
        return self._inner.queues

    @property
    def queue(self) -> str:
        return self._inner.queue

    @property
    def worker_id(self) -> str:
        return self._inner.worker_id

    @property
    def concurrency(self) -> int:
        return self._inner.concurrency

    def handle(self, type: str, handler: AsyncHandler) -> AsyncWorker:
        def invoke(payload: Any, context: HandlerContext) -> Json:
            loop = self._require_loop()
            async_context = _AsyncContextAdapter(context, loop).context()
            return asyncio.run_coroutine_threadsafe(
                _await_value(handler(payload, async_context)), loop
            ).result()

        self._inner.handle(type, invoke)
        return self

    def handle_batch(
        self,
        type: str,
        handler: AsyncBatchHandler,
        *,
        max_size: int,
        linger_ms: int,
    ) -> AsyncWorker:
        def invoke(items: Sequence[BatchHandlerItem]) -> Sequence[BatchHandlerOutcome]:
            loop = self._require_loop()
            async_items = tuple(_AsyncBatchContextAdapter(item, loop).item for item in items)
            return asyncio.run_coroutine_threadsafe(
                _await_value(handler(async_items)), loop
            ).result()

        self._inner.handle_batch(type, invoke, max_size=max_size, linger_ms=linger_ms)
        return self

    async def run_once(self) -> bool:
        self._start_run()
        try:
            return await self._run_inner(self._inner.run_once)
        finally:
            self._running = False

    async def run(self) -> None:
        self._start_run()
        stop_notifications = asyncio.Event()
        listener = (
            asyncio.create_task(self._listen(stop_notifications))
            if self._notification_connection_factory is not None
            else None
        )
        try:
            await self._run_inner(self._inner.run)
        finally:
            stop_notifications.set()
            if listener is not None:
                listener.cancel()
                with suppress(asyncio.CancelledError):
                    await listener
            self._running = False

    def pause(self) -> None:
        self._inner.pause()

    def resume(self) -> None:
        self._inner.resume()

    def is_paused(self) -> bool:
        return self._inner.is_paused()

    def stop(self) -> None:
        self._inner.stop()

    def _start_run(self) -> None:
        if self._running:
            raise RuntimeError("AsyncWorker already has an active run call")
        loop = asyncio.get_running_loop()
        self._running = True
        self._loop = loop
        self._bridge.bind(loop)

    async def _run_inner(self, operation: Callable[[], T]) -> T:
        run = asyncio.create_task(asyncio.to_thread(operation))
        try:
            return await asyncio.shield(run)
        except asyncio.CancelledError:
            self._inner.stop()
            await run
            raise

    def _require_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is None:
            raise RuntimeError("AsyncWorker handler ran outside an active run call")
        return self._loop

    async def _listen(self, stop: asyncio.Event) -> None:
        reconnect_seconds = _RECONNECT_INITIAL_SECONDS
        while not stop.is_set():
            connection: Any | None = None
            try:
                factory = cast(
                    AsyncNotificationConnectionFactory, self._notification_connection_factory
                )
                connection = await factory()
                if connection is self._query_connection:
                    connection = None
                    raise ValueError("Notification connection must be separate from the worker")
                if self._driver == "psycopg":
                    await self._listen_psycopg(connection, stop)
                else:
                    await self._listen_asyncpg(connection, stop)
                reconnect_seconds = _RECONNECT_INITIAL_SECONDS
            except asyncio.CancelledError:
                raise
            except BaseException as error:
                if self._on_notification_error is not None:
                    self._on_notification_error(error)
                self._inner._wake_dispatcher()
            finally:
                self._inner._set_notification_listening(False)
                if connection is not None:
                    try:
                        closed = connection.close()
                        if inspect.isawaitable(closed):
                            await closed
                    except BaseException as error:
                        if self._on_notification_error is not None:
                            self._on_notification_error(error)
            if stop.is_set():
                return
            await asyncio.sleep(reconnect_seconds * random.uniform(0.9, 1.1))
            reconnect_seconds = min(_RECONNECT_MAX_SECONDS, reconnect_seconds * 2)

    async def _listen_psycopg(self, connection: Any, stop: asyncio.Event) -> None:
        if getattr(connection, "autocommit", False) is not True:
            raise ValueError("Notification connection must use autocommit mode")
        await connection.execute(f"LISTEN {_CHANNEL}")
        self._inner._set_notification_listening(True)
        self._inner._wake_from_notification()
        while not stop.is_set():
            async for notification in connection.notifies(timeout=0.1, stop_after=1):
                if notification.payload == "*" or notification.payload in self.queues:
                    self._inner._wake_from_notification()

    async def _listen_asyncpg(self, connection: Any, stop: asyncio.Event) -> None:
        if connection.is_in_transaction():
            raise ValueError("Notification connection must not have an active transaction")

        def wake(_connection: object, _pid: int, _channel: str, payload: str) -> None:
            if payload == "*" or payload in self.queues:
                self._inner._wake_from_notification()

        await connection.add_listener(_CHANNEL, wake)
        self._inner._set_notification_listening(True)
        self._inner._wake_from_notification()
        while not stop.is_set() and not connection.is_closed():
            with suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=0.1)
        await connection.remove_listener(_CHANNEL, wake)
