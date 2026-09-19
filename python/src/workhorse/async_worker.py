from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable, Coroutine, Mapping, Sequence
from concurrent.futures import Future
from contextlib import suppress
from functools import partial
from itertools import count
from queue import Empty, SimpleQueue
from threading import Lock, Thread
from typing import Any, Literal, Protocol, TypeVar, cast

from ._compatibility import AsyncRowExecutor as _AsyncRowExecutor
from ._drivers import (
    AsyncpgExecutor as _AsyncpgExecutor,
    AsyncpgPool as _AsyncpgPool,
    AsyncPsycopgExecutor as _AsyncPsycopgExecutor,
    AsyncPsycopgPool as _AsyncPsycopgPool,
    PooledAsyncpgExecutor as _PooledAsyncpgExecutor,
    PooledAsyncPsycopgExecutor as _PooledAsyncPsycopgExecutor,
)
from ._statements import DriverStatement as _DriverStatement
from .types import (
    AsyncBatchHandlerContext,
    AsyncBatchHandlerItem,
    AsyncCancellationToken,
    AsyncHandlerContext,
    BatchHandlerItem,
    BatchHandlerOutcome,
    ChildOutcome,
    ChildTaskRequest,
    EnqueueOptions,
    HandlerContext,
    Json,
    TaskCheckpoint,
    TaskProgress,
    TaskWait,
)
from .worker import Worker

AsyncHandler = Callable[[Any, AsyncHandlerContext], Awaitable[Json]]
AsyncBatchHandler = Callable[
    [Sequence[AsyncBatchHandlerItem]], Awaitable[Sequence[BatchHandlerOutcome]]
]
_AsyncNotificationConnectionFactory = Callable[[], Awaitable[Any]]

_CHANNEL = "workhorse_tasks"
_RECONNECT_INITIAL_SECONDS = 0.1
_RECONNECT_MAX_SECONDS = 5.0
_BRIDGE_IDLE_SECONDS = 5.0
_T = TypeVar("_T")

_BridgeCall = tuple["Future[Any]", Callable[[], Any]]


async def _await_value[T](value: Awaitable[T]) -> T:
    return await value


class _BridgeThreads:
    """Run blocking context calls on threads that grow with the calls in flight.

    A context call blocks its thread until the event loop resolves the awaited
    operation, and that operation may make another context call. A fixed-size pool
    deadlocks once every thread waits on an operation that needs a free thread, so
    this pool starts a thread whenever no idle thread can take the call. Idle
    threads retire, so a worker keeps only the threads its handlers still need.
    """

    def __init__(self) -> None:
        self._lock = Lock()
        self._calls: SimpleQueue[_BridgeCall | None] = SimpleQueue()
        self._idle = 0
        self._numbers = count()
        self._closed = False

    def run(self, operation: Callable[[], _T]) -> Future[_T]:
        """Schedule the operation and return the future that carries its outcome."""
        call: Future[_T] = Future()
        with self._lock:
            if self._closed:
                raise RuntimeError("AsyncWorker context calls require an active run call")
            if self._idle == 0:
                Thread(
                    target=self._work,
                    name=f"workhorse-async-bridge-{next(self._numbers)}",
                    daemon=True,
                ).start()
            else:
                self._idle -= 1
            self._calls.put((call, operation))
        return call

    def close(self) -> None:
        """Refuse further calls and retire every idle thread."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            for _ in range(self._idle):
                self._calls.put(None)
            self._idle = 0

    def _work(self) -> None:
        while True:
            try:
                call = self._calls.get(timeout=_BRIDGE_IDLE_SECONDS)
            except Empty:
                with self._lock:
                    if not self._calls.empty():
                        continue
                    self._idle -= 1
                    return
            if call is None:
                return
            pending, operation = call
            if pending.set_running_or_notify_cancel():
                try:
                    pending.set_result(operation())
                except BaseException as error:
                    pending.set_exception(error)
            with self._lock:
                if self._closed:
                    return
                self._idle += 1


class _AsyncExecutorBridge:
    """Expose an async driver to the shared synchronous lifecycle core."""

    def __init__(self, executor: _AsyncRowExecutor) -> None:
        self._executor = executor
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def rows(
        self, statement: _DriverStatement, parameters: Sequence[object] = ()
    ) -> list[Mapping[str, object]]:
        loop = self._loop
        if loop is None:
            raise RuntimeError("AsyncWorker database access requires an active run call")
        future = asyncio.run_coroutine_threadsafe(self._rows(statement, parameters), loop)
        return future.result()

    async def _rows(
        self, statement: _DriverStatement, parameters: Sequence[object]
    ) -> list[Mapping[str, object]]:
        if self._loop is None:
            raise RuntimeError("AsyncWorker database bridge is not bound")
        rows = await self._executor.rows(statement, parameters)
        # Executors already return fresh dicts per row; nothing else holds them.
        return list(rows)


class _CheckpointContext(Protocol):
    def get_checkpoint(self, name: str) -> TaskCheckpoint | None: ...

    def checkpoint(self, name: str, operation: Callable[[], Json]) -> Json: ...

    def get_progress(self) -> TaskProgress | None: ...

    def set_progress(self, value: Json) -> TaskProgress: ...


class _AsyncCheckpointAdapter:
    def __init__(
        self,
        context: _CheckpointContext,
        loop: asyncio.AbstractEventLoop,
        threads: _BridgeThreads,
    ) -> None:
        self._checkpoint_context = context
        self._loop = loop
        self._threads = threads

    async def _call(self, operation: Callable[..., _T], /, *arguments: Any) -> _T:
        """Await a synchronous context call without holding an event loop thread."""
        return await asyncio.wrap_future(self._threads.run(partial(operation, *arguments)))

    async def get_checkpoint(self, name: str) -> TaskCheckpoint | None:
        return await self._call(self._checkpoint_context.get_checkpoint, name)

    async def checkpoint(self, name: str, operation: Callable[[], Awaitable[Json]]) -> Json:
        def invoke_operation() -> Json:
            return asyncio.run_coroutine_threadsafe(_await_value(operation()), self._loop).result()

        return await self._call(self._checkpoint_context.checkpoint, name, invoke_operation)

    async def get_progress(self) -> TaskProgress | None:
        return await self._call(self._checkpoint_context.get_progress)

    async def set_progress(self, value: Json) -> TaskProgress:
        return await self._call(self._checkpoint_context.set_progress, value)


class _AsyncContextAdapter(_AsyncCheckpointAdapter):
    def __init__(
        self,
        context: HandlerContext,
        loop: asyncio.AbstractEventLoop,
        threads: _BridgeThreads,
    ) -> None:
        super().__init__(context, loop, threads)
        self._context = context

    def context(self) -> AsyncHandlerContext:
        return AsyncHandlerContext(
            self._context.task,
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
            self.run_children_all,
        )

    async def get_wait(self, name: str) -> TaskWait | None:
        return await self._call(self._context.get_wait, name)

    async def sleep(self, name: str, duration_ms: int) -> None:
        await self._call(self._context.sleep, name, duration_ms)

    async def sleep_until(self, name: str, wake_at: Any) -> None:
        await self._call(self._context.sleep_until, name, wake_at)

    async def wait_for_signal(self, name: str, timeout_ms: int | None) -> Json:
        return await self._call(partial(self._context.wait_for_signal, name, timeout_ms=timeout_ms))

    async def wait_for_human(self, name: str, context: Json, timeout_ms: int | None) -> Json:
        return await self._call(
            partial(self._context.wait_for_human, name, context, timeout_ms=timeout_ms)
        )

    async def run_child(self, name: str, type: str, payload: Json, options: EnqueueOptions) -> Json:
        return await self._call(self._context.run_child, name, type, payload, options)

    async def run_children(self, children: Sequence[ChildTaskRequest]) -> dict[str, ChildOutcome]:
        return await self._call(self._context.run_children, children)

    async def run_children_all(self, children: Sequence[ChildTaskRequest]) -> dict[str, Json]:
        return await self._call(self._context.run_children_all, children)


class _AsyncBatchContextAdapter(_AsyncCheckpointAdapter):
    def __init__(
        self,
        item: BatchHandlerItem,
        loop: asyncio.AbstractEventLoop,
        threads: _BridgeThreads,
    ) -> None:
        super().__init__(item.context, loop, threads)
        self._context = item.context
        self.item = AsyncBatchHandlerItem(
            item.payload,
            AsyncBatchHandlerContext(
                item.context.task,
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
        executor: _AsyncRowExecutor,
        pool: object,
        driver: Literal["psycopg", "asyncpg"],
        *,
        on_notification_error: Callable[[BaseException], None] | None = None,
        on_registration_error: Callable[[BaseException], None] | None = None,
        shared_heartbeats: bool = False,
        **worker_options: Any,
    ) -> None:
        self._bridge = _AsyncExecutorBridge(executor)
        self._pool = pool
        self._driver = driver
        self._notification_connection_factory = None
        self._on_notification_error = on_notification_error
        self._loop: asyncio.AbstractEventLoop | None = None
        self._running = False
        self._threads = _BridgeThreads()
        self._heartbeat_connection_factory = None
        self._inner = Worker(
            cast(Any, pool),
            on_notification_error=on_notification_error,
            on_registration_error=on_registration_error,
            _executor=self._bridge,
            shared_heartbeats=shared_heartbeats,
            _heartbeat_executor_factory=(
                None if shared_heartbeats else self._open_heartbeat_executor
            ),
            **worker_options,
        )

    @classmethod
    def from_psycopg(
        cls,
        pool: _AsyncPsycopgPool,
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
        on_notification_error: Callable[[BaseException], None] | None = None,
        on_registration_error: Callable[[BaseException], None] | None = None,
        shared_heartbeats: bool = False,
    ) -> AsyncWorker:
        return cls(
            _PooledAsyncPsycopgExecutor(pool),
            pool,
            "psycopg",
            on_notification_error=on_notification_error,
            on_registration_error=on_registration_error,
            shared_heartbeats=shared_heartbeats,
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
        pool: _AsyncpgPool,
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
        on_notification_error: Callable[[BaseException], None] | None = None,
        on_registration_error: Callable[[BaseException], None] | None = None,
        shared_heartbeats: bool = False,
    ) -> AsyncWorker:
        return cls(
            _PooledAsyncpgExecutor(pool),
            pool,
            "asyncpg",
            on_notification_error=on_notification_error,
            on_registration_error=on_registration_error,
            shared_heartbeats=shared_heartbeats,
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
            async_context = _AsyncContextAdapter(context, loop, self._threads).context()
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
            async_items = tuple(
                _AsyncBatchContextAdapter(item, loop, self._threads).item for item in items
            )
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
            self._threads.close()
            self._running = False

    async def run(self) -> None:
        self._start_run()
        stop_notifications = asyncio.Event()
        listener = asyncio.create_task(self._listen(stop_notifications))
        try:
            await self._run_inner(self._inner.run)
        finally:
            stop_notifications.set()
            listener.cancel()
            with suppress(asyncio.CancelledError):
                await listener
            self._threads.close()
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
        self._threads = _BridgeThreads()
        self._bridge.bind(loop)

    async def _run_inner(self, operation: Callable[[], _T]) -> _T:
        run = asyncio.wrap_future(self._threads.run(operation))
        try:
            return await asyncio.shield(run)
        except asyncio.CancelledError:
            self._inner.stop()
            await run
            raise

    def _open_heartbeat_executor(self) -> tuple[_AsyncExecutorBridge, Callable[[], None]]:
        """Reserve one pool connection for heartbeat rounds."""
        loop = self._require_loop()

        async def acquire() -> tuple[Any, Callable[[], Coroutine[Any, Any, None]]]:
            if self._driver == "psycopg":
                psycopg_pool = cast(_AsyncPsycopgPool, self._pool)
                context = psycopg_pool.connection()
                connection = await context.__aenter__()

                async def close_psycopg() -> None:
                    await context.__aexit__(None, None, None)

                return connection, close_psycopg
            asyncpg_pool = cast(_AsyncpgPool, self._pool)
            connection = await asyncpg_pool.acquire()

            async def close_asyncpg() -> None:
                await asyncpg_pool.release(connection)

            return connection, close_asyncpg

        connection, close_async = asyncio.run_coroutine_threadsafe(acquire(), loop).result()

        def close() -> None:
            asyncio.run_coroutine_threadsafe(close_async(), loop).result()

        if self._driver == "psycopg":
            if getattr(connection, "autocommit", False) is not True:
                close()
                raise ValueError("Heartbeat connection must be in autocommit mode")
            executor: _AsyncRowExecutor = _AsyncPsycopgExecutor(connection)
        else:
            executor = _AsyncpgExecutor(connection)
        bridge = _AsyncExecutorBridge(executor)
        bridge.bind(loop)
        return bridge, close

    def _require_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is None:
            raise RuntimeError("AsyncWorker handler ran outside an active run call")
        return self._loop

    async def _listen(self, stop: asyncio.Event) -> None:
        reconnect_seconds = _RECONNECT_INITIAL_SECONDS
        while not stop.is_set():
            connection: Any | None = None
            context: Any | None = None
            try:
                if self._driver == "psycopg":
                    psycopg_pool = cast(_AsyncPsycopgPool, self._pool)
                    context = psycopg_pool.connection()
                    connection = await context.__aenter__()
                else:
                    asyncpg_pool = cast(_AsyncpgPool, self._pool)
                    connection = await asyncpg_pool.acquire()
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
                        if self._driver == "psycopg":
                            await cast(Any, context).__aexit__(None, None, None)
                        else:
                            await cast(_AsyncpgPool, self._pool).release(connection)
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


__all__ = ["AsyncBatchHandler", "AsyncHandler", "AsyncWorker"]
