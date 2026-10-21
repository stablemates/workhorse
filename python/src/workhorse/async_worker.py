from __future__ import annotations

import asyncio
import contextvars
from collections.abc import Awaitable, Callable, Mapping, Sequence
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
from contextlib import suppress
from functools import partial
from itertools import count
from queue import Empty, SimpleQueue
from threading import Lock, Thread
from time import monotonic
from typing import Any, Literal, Protocol, TypeVar, cast

from ._compatibility import AsyncRowExecutor as _AsyncRowExecutor
from ._drivers import (
    AsyncpgExecutor as _AsyncpgExecutor,
    AsyncpgPool as _AsyncpgPool,
    AsyncPsycopgExecutor as _AsyncPsycopgExecutor,
    AsyncPsycopgPool as _AsyncPsycopgPool,
    PooledAsyncpgExecutor as _PooledAsyncpgExecutor,
    PooledAsyncPsycopgExecutor as _PooledAsyncPsycopgExecutor,
    StatementCheck as _StatementCheck,
    pool_connection as _pool_connection,
)
from ._pool_hub import (
    ASYNC_PSYCOPG_HUBS as _ASYNC_PSYCOPG_HUBS,
    ASYNCPG_HUBS as _ASYNCPG_HUBS,
    CLEANUP_SECONDS as _CLEANUP_SECONDS,
    HEARTBEAT as _HEARTBEAT,
    AsyncConnectionOwner as _AsyncConnectionOwner,
    AsyncNotificationSubscription as _AsyncNotificationSubscription,
    AsyncTaskNotificationListener as _AsyncTaskNotificationListener,
    HeartbeatReservation as _HeartbeatReservation,
    PoolHub as _PoolHub,
    PoolRegistry as _PoolRegistry,
    pool_label as _pool_label,
    require_pool as _require_pool,
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
    ClaimedTask as _ClaimedTask,
    EnqueueOptions,
    EnqueueRequest,
    EnqueueResult,
    HandlerContext,
    Json,
    TaskCheckpoint,
    TaskGroupLink,
    TaskProgress,
    TaskWait,
    _NoInput,
)
from .worker import Worker, _CheckedExecutor

AsyncHandler = Callable[[Any, AsyncHandlerContext], Awaitable[Json]]
AsyncBatchHandler = Callable[
    [Sequence[AsyncBatchHandlerItem]], Awaitable[Sequence[BatchHandlerOutcome]]
]

_BRIDGE_IDLE_SECONDS = 5.0
_T = TypeVar("_T")

_BridgeCall = tuple["Future[Any]", Callable[[], Any]]


async def _await_value[T](value: Awaitable[T]) -> T:
    return await value


async def _await_bridge_call[T](
    call: asyncio.Future[T], on_cancel: Callable[[], None] | None = None
) -> T:
    """Await a bridge call, and on cancellation wait for it to return before re-raising.

    A thread cannot be interrupted, so a cancelled caller waits for the call to
    return. The handler then never settles while its context call still writes for
    the attempt. The call's own outcome is consumed so that it is never reported as
    unretrieved, and the caller's cancellation wins over it. ``asyncio.wait`` leaves
    the call running when the caller is cancelled, unlike ``asyncio.shield``, which
    on Python 3.14 reports a later failure of the call as an unhandled exception.
    """
    try:
        await asyncio.wait((call,))
    except asyncio.CancelledError:
        if on_cancel is not None:
            on_cancel()
        while not call.done():
            with suppress(asyncio.CancelledError):
                await asyncio.wait((call,))
        if not call.cancelled():
            call.exception()
        raise
    return call.result()


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

    def __init__(self, executor: _AsyncRowExecutor, *, wait: float | None = None) -> None:
        self._executor = executor
        self._loop: asyncio.AbstractEventLoop | None = None
        # The longest wait for one call, in seconds. None waits for the driver.
        self._wait = wait

    def checked(self, check: _StatementCheck) -> _AsyncExecutorBridge:
        """This bridge, whose executor runs `check` after each borrow and before each statement.

        The check runs on the event loop.
        """
        checked = getattr(self._executor, "checked", None)
        if not callable(checked):
            return cast(_AsyncExecutorBridge, _CheckedExecutor(self, check))
        bridge = _AsyncExecutorBridge(cast(_AsyncRowExecutor, checked(check)), wait=self._wait)
        bridge._loop = self._loop
        return bridge

    def within(self, timeout: float) -> _AsyncExecutorBridge:
        """This bridge, with each wait for a pool connection bounded by ``timeout`` seconds."""
        within = getattr(self._executor, "within", None)
        if not callable(within):
            return self
        bridge = _AsyncExecutorBridge(cast(_AsyncRowExecutor, within(timeout)), wait=timeout)
        bridge._loop = self._loop
        return bridge

    @property
    def dialect(self) -> str:
        return cast(str, getattr(self._executor, "dialect", "psycopg"))

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def rows(
        self, statement: _DriverStatement, parameters: Sequence[object] = ()
    ) -> list[Mapping[str, object]]:
        loop = self._loop
        if loop is None:
            raise RuntimeError("AsyncWorker database access requires an active run call")
        future = asyncio.run_coroutine_threadsafe(self._rows(statement, parameters), loop)
        if self._wait is None:
            return future.result()
        try:
            return future.result(self._wait)
        except FutureTimeoutError:
            future.cancel()
            raise TimeoutError("the event loop did not answer in time") from None

    def discard(self) -> None:
        """Close the driver connection, so its pool can only discard it."""
        loop = self._loop
        connection = getattr(self._executor, "connection", None)
        if loop is None or connection is None:
            return
        terminate = getattr(connection, "terminate", None)

        async def close() -> None:
            if callable(terminate):
                terminate()
            else:
                await connection.close()

        # A stalled event loop must not hold a heartbeat round or a stop.
        with suppress(FutureTimeoutError):
            asyncio.run_coroutine_threadsafe(close(), loop).result(_CLEANUP_SECONDS)

    def command(self, statement: _DriverStatement, parameters: Sequence[object] = ()) -> None:
        """Send a statement that returns no rows, such as BEGIN."""
        loop = self._loop
        if loop is None:
            raise RuntimeError("AsyncWorker database access requires an active run call")
        command = cast(Any, self._executor).command
        asyncio.run_coroutine_threadsafe(command(statement, parameters), loop).result()

    def prepare(self, statement: _DriverStatement) -> None:
        """Prepare `statement` when the driver prepares in a cycle of its own (asyncpg)."""
        prepare = getattr(self._executor, "prepare", None)
        if prepare is None:
            return
        loop = self._loop
        if loop is None:
            raise RuntimeError("AsyncWorker database access requires an active run call")
        asyncio.run_coroutine_threadsafe(prepare(statement), loop).result()

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

    def checkpoint(
        self, name: str, operation: Callable[[], Json], *, input: Json | _NoInput = ...
    ) -> Json: ...

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
        return await _await_bridge_call(
            asyncio.wrap_future(self._threads.run(partial(operation, *arguments)))
        )

    async def get_checkpoint(self, name: str) -> TaskCheckpoint | None:
        return await self._call(self._checkpoint_context.get_checkpoint, name)

    async def checkpoint(
        self,
        name: str,
        operation: Callable[[], Awaitable[Json]],
        input: Json | _NoInput = _NoInput.NO_INPUT,
    ) -> Json:
        # The operation and the cancellation callback both run on the event loop. The
        # tracked task calls the operation in its first step, so a cancellation either
        # stops it before the operation is created or cancels it while it runs.
        # The task runs in a copy of the handler's context, as a task the handler
        # created would, so context variables and the current span reach the operation.
        handler_context = contextvars.copy_context()
        cancelled = False
        running: asyncio.Task[Any] | None = None

        async def run_operation() -> Json:
            nonlocal running
            if cancelled:
                raise asyncio.CancelledError
            running = asyncio.current_task()
            value = await operation()
            if cancelled:
                # The operation absorbed its cancellation, but the caller has moved on,
                # so the core must not save the value as a checkpoint.
                raise asyncio.CancelledError
            return value

        def invoke_operation() -> Json:
            # The bridge thread's own context is empty. Scheduling from the handler's
            # context makes the loop create the tracked task in that context.
            return handler_context.run(
                asyncio.run_coroutine_threadsafe, run_operation(), self._loop
            ).result()

        def cancel_operation() -> None:
            nonlocal cancelled
            cancelled = True
            if running is not None:
                running.cancel()

        # The operation's cleanup finishes before the core sees the cancellation, and
        # the core saves no checkpoint for it.
        return await _await_bridge_call(
            asyncio.wrap_future(
                self._threads.run(
                    partial(
                        self._checkpoint_context.checkpoint, name, invoke_operation, input=input
                    )
                )
            ),
            cancel_operation,
        )

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
            self.get_task_group,
            self.add_to_task_group,
        )

    async def get_task_group(self) -> TaskGroupLink | None:
        return await self._call(self._context.task_group.get)

    async def add_to_task_group(self, requests: Sequence[EnqueueRequest]) -> list[EnqueueResult]:
        return await self._call(self._context.task_group.add, requests)

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
                self.get_task_group,
                self.add_to_task_group,
            ),
        )

    async def get_task_group(self) -> TaskGroupLink | None:
        return await self._call(self._context.task_group.get)

    async def add_to_task_group(self, requests: Sequence[EnqueueRequest]) -> list[EnqueueResult]:
        return await self._call(self._context.task_group.add, requests)


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
        self._on_notification_error = on_notification_error
        self._loop: asyncio.AbstractEventLoop | None = None
        self._running = False
        self._threads = _BridgeThreads()
        # The hub of the pool while a run is active: the listener and heartbeat connection that
        # every AsyncWorker on the pool shares.
        self._hub: _PoolHub | None = None
        # The listener subscription of the active run, made once the core started.
        self._subscription: _AsyncNotificationSubscription | None = None
        self._wants_listener = False
        self._inner = Worker(
            cast(Any, pool),
            on_notification_error=on_notification_error,
            on_registration_error=on_registration_error,
            _executor=self._bridge,
            shared_heartbeats=shared_heartbeats,
            **worker_options,
        )
        # The async run attaches to the hub and listens on the event loop, so the core only
        # takes the hub's heartbeat reservation.
        self._inner._listens = False
        self._inner._hub_source = self._core_hub

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
        maintenance_routine_poll_ms: int = 60_000,
        registry_interval_ms: int = 5_000,
        retry_delay_ms: int | Callable[[int, _ClaimedTask], int | None] | None = None,
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
            maintenance_routine_poll_ms=maintenance_routine_poll_ms,
            registry_interval_ms=registry_interval_ms,
            retry_delay_ms=retry_delay_ms,
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
        maintenance_routine_poll_ms: int = 60_000,
        registry_interval_ms: int = 5_000,
        retry_delay_ms: int | Callable[[int, _ClaimedTask], int | None] | None = None,
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
            maintenance_routine_poll_ms=maintenance_routine_poll_ms,
            registry_interval_ms=registry_interval_ms,
            retry_delay_ms=retry_delay_ms,
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
            self._attach_hub()
            return await self._run_inner(self._inner.run_once)
        finally:
            self._detach_hub()
            self._threads.close()
            self._running = False

    async def run(self) -> None:
        self._start_run()
        completed = False
        interrupted = False
        try:
            self._attach_hub()
            # The listener is best effort, so it subscribes only after the core reserved the
            # heartbeat connection and ran the compatibility query (ADR 0071, rule 3).
            self._wants_listener = True
            self._inner._on_connections_ready = self._subscribe_listener
            await self._run_inner(self._inner.run)
            completed = True
        finally:
            self._wants_listener = False
            self._inner._on_connections_ready = None
            subscription, self._subscription = self._subscription, None
            stopping = subscription.close() if subscription is not None else None
            if stopping is not None:
                # The last worker on the pool stops the listener. A later cancellation must not
                # cut its connection release short, so the run waits for it without forwarding
                # that cancellation. The wait spends the rest of the core's cleanup window, so
                # the stop takes no new budget (ADR 0071, rule 8).
                deadline = getattr(self._inner, "_cleanup_deadline", None) or (
                    monotonic() + _CLEANUP_SECONDS
                )
                while not stopping.done():
                    remaining = deadline - monotonic()
                    if remaining <= 0:
                        break
                    try:
                        await asyncio.wait((stopping,), timeout=remaining)
                    except asyncio.CancelledError:
                        interrupted = True
                if stopping.done() and not stopping.cancelled():
                    stopping.exception()
            self._inner._set_notification_listening(False)
            self._detach_hub()
            self._threads.close()
            self._running = False
        if interrupted and completed:
            raise asyncio.CancelledError

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
            # A nested timeout or a TaskGroup can cancel again while the core drains.
            # Returning then would close the bridge under live handlers and let a new
            # run overlap this one, so every later cancellation waits for the drain too.
            while not run.done():
                with suppress(asyncio.CancelledError):
                    await asyncio.wait((run,))
            run.result()
            raise

    def _subscribe_listener(self) -> None:
        """Subscribe this run to the shared listener. The core calls this from its thread."""
        loop = self._require_loop()

        async def subscribe() -> None:
            if not self._wants_listener or self._hub is None or self._subscription is not None:
                return
            listener = cast(_AsyncTaskNotificationListener, self._hub.listener)
            self._subscription = listener.subscribe(
                self.queues,
                self._inner._wake_from_notification,
                self._on_notification_error,
                self._inner._set_notification_listening,
            )

        with suppress(FutureTimeoutError):
            asyncio.run_coroutine_threadsafe(subscribe(), loop).result(_CLEANUP_SECONDS)

    def _registry(self) -> _PoolRegistry:
        return _ASYNC_PSYCOPG_HUBS if self._driver == "psycopg" else _ASYNCPG_HUBS

    def _attach_hub(self) -> _PoolHub:
        """Attach to the hub of the pool on the running event loop.

        A worker refuses to start on another event loop than the pool's (ADR 0071, rule 9).
        """
        loop = self._require_loop()
        pool_loop = _pool_event_loop(self._pool)
        if pool_loop is not None and pool_loop is not loop:
            raise RuntimeError(
                f"AsyncWorker cannot start: the {self._driver} pool {_pool_label(self._pool)} "
                "belongs to another event loop. Run the worker on the event loop of its pool."
            )
        # The registry remembers the loop of the pool, also before the first worker of a pool
        # that does not tell its loop, and after its last worker stopped.
        self._hub = self._registry().attach(self._pool, self._create_hub, loop)
        return self._hub

    def _detach_hub(self) -> None:
        hub, self._hub = self._hub, None
        if hub is not None:
            self._registry().detach(hub)

    def _core_hub(self) -> tuple[_PoolHub | None, Callable[[], None]]:
        """The hub that the active run attached. The run, not the core, detaches it."""
        return self._hub, lambda: None

    def _create_hub(self, pool_ref: Callable[[], Any]) -> _PoolHub:
        """The hub of an async pool. Its one `AsyncConnectionOwner` opens and releases every
        connection that the hub reserves, the listener's and the heartbeat connection."""
        loop = self._require_loop()
        driver = self._driver

        # The timeout is the pool's own wait, as asyncpg and psycopg name it.
        async def open_connection(timeout: float) -> tuple[Any, Callable[[], Awaitable[None]]]:  # noqa: ASYNC109
            pool = _require_pool(pool_ref)
            if driver == "psycopg":
                context = _pool_connection(cast(_AsyncPsycopgPool, pool), timeout)
                connection = await context.__aenter__()

                async def release_psycopg() -> None:
                    await context.__aexit__(None, None, None)

                return connection, release_psycopg
            asyncpg_pool = cast(_AsyncpgPool, pool)
            connection = await asyncpg_pool.acquire(timeout=timeout)

            async def release_asyncpg() -> None:
                await asyncpg_pool.release(connection)

            return connection, release_asyncpg

        owner = _AsyncConnectionOwner(loop, open_connection, _terminate_connection)
        return _PoolHub(
            _pool_label(pool_ref()),
            _AsyncTaskNotificationListener(driver, owner),
            _HeartbeatReservation(_async_heartbeat_acquire(loop, owner, driver)),
            loop,
            owner,
        )

    def _require_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is None:
            raise RuntimeError("AsyncWorker handler ran outside an active run call")
        return self._loop


def _pool_event_loop(pool: object) -> asyncio.AbstractEventLoop | None:
    """The event loop that an async pool belongs to, where the pool tells it.

    An asyncpg pool keeps its loop. An open psycopg ``AsyncConnectionPool`` runs its scheduler
    task on its loop.
    """
    loop = getattr(pool, "_loop", None)
    if isinstance(loop, asyncio.AbstractEventLoop):
        return loop
    scheduler = getattr(pool, "_sched_runner", None)
    if isinstance(scheduler, asyncio.Task):
        return scheduler.get_loop()
    return None


async def _terminate_connection(connection: Any) -> None:
    """Close a driver connection in an unknown state, so its pool can only discard it."""
    terminate = getattr(connection, "terminate", None)
    if callable(terminate):
        terminate()
    else:
        await connection.close()


class _OwnedHeartbeatBridge(_AsyncExecutorBridge):
    """A heartbeat bridge whose connection the hub's owner gives back, also a broken one."""

    def __init__(self, executor: _AsyncRowExecutor, give_back: Callable[[bool], None]) -> None:
        super().__init__(executor)
        self._give_back = give_back

    def discard(self) -> None:
        """Let the owner close the driver connection, then give it back to the pool."""
        self._give_back(True)


def _async_heartbeat_acquire(
    loop: asyncio.AbstractEventLoop, owner: _AsyncConnectionOwner, driver: str
) -> Callable[[float], tuple[_AsyncExecutorBridge, Callable[[], None]]]:
    """Reserve the shared heartbeat connection of an async pool through the hub's owner.

    The owner holds at most one heartbeat connection, so a replacement waits until the earlier
    one is back in the pool. A connection that arrives after the wait ended goes back through
    the owner.
    """

    def acquire(timeout: float) -> tuple[_AsyncExecutorBridge, Callable[[], None]]:
        connection = owner.acquire(_HEARTBEAT, monotonic() + timeout)
        given_back = Lock()
        returned = False

        def give_back(broken: bool) -> None:
            nonlocal returned
            with given_back:
                if returned:
                    return
                returned = True
            # A stalled event loop must not hold a heartbeat round or a stop. The owner gives the
            # connection back also after this wait ends.
            owner.release(
                _HEARTBEAT, connection, broken=broken, deadline=monotonic() + _CLEANUP_SECONDS
            )

        def close() -> None:
            give_back(False)

        if driver == "psycopg":
            if getattr(connection, "autocommit", False) is not True:
                close()
                raise ValueError("Heartbeat connection must be in autocommit mode")
            # psycopg then parses the heartbeat statement inside its statement_timeout. asyncpg
            # cannot do that, so a round prepares the statement before it sets that timeout.
            executor: _AsyncRowExecutor = _AsyncPsycopgExecutor(connection, prepare=False)
        else:
            executor = _AsyncpgExecutor(connection)
        bridge = _OwnedHeartbeatBridge(executor, give_back)
        bridge.bind(loop)
        return bridge, close

    return acquire


__all__ = ["AsyncBatchHandler", "AsyncHandler", "AsyncWorker"]
