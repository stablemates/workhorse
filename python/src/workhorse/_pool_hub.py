"""The listener connection and the heartbeat connection that every worker on one pool shares.

ADR 0071 gives each pool identity one listener connection and one heartbeat connection. In Python a
pool identity is the pool object, in one of three domains: the psycopg sync pool, the psycopg async
pool, and the asyncpg pool. Each domain has its own `PoolRegistry`, so the domains never share.

A `PoolHub` holds the shared listener and the shared `HeartbeatReservation` of one pool. A worker
attaches to the hub for one run and detaches when the run ends. The registry forgets the hub when
the last worker detaches. It keeps only a weak reference to the pool, so it never extends the life
of a pool.

An async hub belongs to the event loop of its pool. A worker on a different event loop refuses to
start.
"""

from __future__ import annotations

import asyncio
import random
import weakref
from collections import deque
from collections.abc import Awaitable, Callable, Sequence
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
from contextlib import suppress
from dataclasses import dataclass
from threading import Condition, Lock, Thread
from time import monotonic
from typing import Any, Literal, Protocol, cast

from ._compatibility import SyncRowExecutor
from ._heartbeat_round import heartbeat_round_bound_ms

# The startup budget is max(I, 5 s), where I is the heartbeat interval (ADR 0071, rule 3). The 5 s
# floor is a design choice. The stop path spends a budget of the same size (rule 8).
_BUDGET_FLOOR_MS = 5_000
# After the drain, deregistration and the release of the shared connections get this long.
CLEANUP_SECONDS = 1.0
# One listener acquisition waits at most the default round bound (ADR 0071, rule 5).
LISTENER_ACQUIRE_SECONDS = heartbeat_round_bound_ms(10_000) / 1000
_RECONNECT_INITIAL_SECONDS = 0.1
# A round holds the shared heartbeat connection until its deadline plus this grace. After that, the
# reservation opens a replacement, and the round closes the connection when it returns.
_LEND_GRACE_SECONDS = CLEANUP_SECONDS
_RECONNECT_MAX_SECONDS = 5.0
_ASYNC_READ_SECONDS = 0.1
_CHANNEL = "workhorse_tasks"


def connection_budget_ms(heartbeat_ms: int) -> int:
    """The startup budget and the stop budget of a worker, in milliseconds: max(I, 5 s)."""
    return max(heartbeat_ms, _BUDGET_FLOOR_MS)


def pool_label(pool: object) -> str:
    """A name for `pool` in an error message: its class, and its name or its address."""
    name = getattr(pool, "name", None)
    kind = type(pool).__name__
    return f"{kind} {name!r}" if isinstance(name, str) and name else f"{kind} at {id(pool):#x}"


def weak_pool[T](pool: T, on_collect: Callable[[], None] | None = None) -> Callable[[], T | None]:
    """A reference to `pool` that does not keep it alive, where the pool supports one."""
    try:
        return weakref.ref(pool, None if on_collect is None else lambda _ref: on_collect())
    except TypeError:
        return lambda: pool


def require_pool[T](pool_ref: Callable[[], T | None]) -> T:
    pool = pool_ref()
    if pool is None:
        raise RuntimeError("The worker pool was garbage collected")
    return pool


class PoolConnectionLease:
    """A connection that a psycopg pool lent through ``pool.connection()``.

    ``close`` gives it back to the pool. ``discard`` closes the driver connection first, so the
    pool can only discard it. A normal return commits an open transaction, so a connection in an
    unknown state must not take that path.
    """

    def __init__(self, context: Any, connection: Any) -> None:
        self._context = context
        self._connection = connection
        self._closed = False

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._context.__exit__(None, None, None)

    def discard(self) -> None:
        try:
            self._connection.close()
        finally:
            self.close()


def discard_round_connection(executor: object) -> None:
    """Close the driver connection under `executor`, so its pool can only discard it."""
    discard = getattr(executor, "discard", None)
    if callable(discard):
        discard()
        return
    connection = getattr(executor, "connection", None)
    if isinstance(connection, PoolConnectionLease):
        connection.discard()
        return
    close = getattr(connection, "close", None)
    if callable(close):
        close()


HEARTBEAT = "heartbeat"
LISTENER = "listener"
# Each pool hub holds at most one connection of each kind.
_KINDS = (HEARTBEAT, LISTENER)

# Opens one pool connection within a timeout in seconds, on the event loop, and returns it with the
# coroutine function that gives it back to the pool.
AsyncOpen = Callable[[float], Awaitable[tuple[Any, Callable[[], Awaitable[None]]]]]


class _Request:
    """One acquisition request, and the handshake that gives its connection one owner.

    The owner delivers the connection only while the caller still waits. A caller that stops
    waiting abandons the request, and the owner then gives the connection back itself. Both sides
    decide under `lock`, so a connection never reaches neither of them.
    """

    def __init__(self, kind: str, deadline: float) -> None:
        self.kind = kind
        self.deadline = deadline
        self.reply: Future[Any] = Future()
        self.lock = Lock()
        self.abandoned = False
        self.delivered = False

    def give_up(self) -> bool:
        """Stop waiting. False when the owner already delivered the connection."""
        with self.lock:
            if self.delivered:
                return False
            self.abandoned = True
            return True


@dataclass(eq=False)
class _Release:
    kind: str
    connection: Any
    broken: bool
    reply: Future[None]


@dataclass(eq=False)
class _Held:
    connection: Any
    release: Callable[[], Awaitable[None]]


class AsyncConnectionOwner:
    """The one owner of the connections that an async pool hub reserves (ADR 0071, rule 7).

    One task on the event loop of the pool does every acquisition, every release, and every late
    disposal, one command at a time. Callers only send commands and wait for replies with their
    own deadline. A connection that arrives after its caller stopped waiting goes back to the
    owner, which gives it back to the pool as its next step. The owner holds at most one connection
    of each kind, the listener and the heartbeat connection. An acquisition of a kind waits until
    the release of the earlier connection of that kind has ended. Heartbeat commands go before
    listener commands when both wait.
    """

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        open_connection: AsyncOpen,
        terminate: Callable[[Any], Awaitable[None]] | None = None,
    ) -> None:
        self._loop = loop
        self._open = open_connection
        self._terminate = terminate
        self._lock = Lock()
        self._queues: dict[str, deque[_Request | _Release]] = {kind: deque() for kind in _KINDS}
        self._deferred: dict[str, deque[_Request]] = {kind: deque() for kind in _KINDS}
        self._held: dict[str, _Held] = {}
        self._working = False
        # The owner task. It runs only while commands wait, so an idle hub leaves no task running.
        self._task: Future[None] | None = None

    def busy(self) -> bool:
        """True while a command waits or runs, or a connection is held."""
        with self._lock:
            return bool(
                self._working
                or self._held
                or any(self._queues.values())
                or any(self._deferred.values())
            )

    def close(self) -> None:
        """Nothing to stop: the owner task ends by itself when no command waits."""

    def acquire(self, kind: str, deadline: float) -> Any:
        """Send an acquisition and wait for its connection until `deadline`. From a thread."""
        request = _Request(kind, deadline)
        self._send(request)
        try:
            return request.reply.result(max(0.0, deadline - monotonic()))
        except FutureTimeoutError:
            if not request.reply.done() and request.give_up():
                raise TimeoutError(f"no {kind} connection by the deadline") from None
            return request.reply.result()

    async def acquire_async(self, kind: str, deadline: float) -> Any:
        """Send an acquisition and await its connection until `deadline`. On the event loop.

        A cancellation abandons the request. A connection that the owner delivered already goes
        back to the owner.
        """
        request = _Request(kind, deadline)
        self._send(request)
        waiting = asyncio.wrap_future(request.reply)
        try:
            return await asyncio.wait_for(asyncio.shield(waiting), max(0.0, deadline - monotonic()))
        except (TimeoutError, asyncio.CancelledError):
            if request.give_up():
                raise
            connection = request.reply.result()
            self._send(_Release(kind, connection, False, Future()))
            raise

    def release(self, kind: str, connection: Any, *, broken: bool, deadline: float) -> None:
        """Give `connection` back through the owner, and wait for it until `deadline`.

        The owner releases it also after the wait ended. A broken connection is closed first, so
        the pool can only discard it. Errors of the release are not raised here.
        """
        command = _Release(kind, connection, broken, Future())
        self._send(command)
        with suppress(Exception):
            command.reply.result(max(0.0, deadline - monotonic()))

    def release_soon(self, kind: str, connection: Any, *, broken: bool = False) -> Future[None]:
        """Send a release and return its reply, which carries an error of the release."""
        command = _Release(kind, connection, broken, Future())
        self._send(command)
        return command.reply

    def _send(self, command: _Request | _Release) -> None:
        with self._lock:
            self._queues[command.kind].append(command)
            if self._task is None or self._task.done():
                self._task = asyncio.run_coroutine_threadsafe(self._run(), self._loop)

    def _next(self) -> _Request | _Release | None:
        """The next command, heartbeat commands first. None ends the owner task.

        The choice and the end of the task happen under one lock, so a command sent at the same
        time starts a new task.
        """
        with self._lock:
            for kind in _KINDS:
                if self._queues[kind]:
                    self._working = True
                    return self._queues[kind].popleft()
            self._task = None
            return None

    async def _run(self) -> None:
        try:
            while (command := self._next()) is not None:
                try:
                    if isinstance(command, _Request):
                        await self._acquire(command)
                    else:
                        await self._release_command(command)
                finally:
                    with self._lock:
                        self._working = False
        except BaseException:
            # An unexpected exit must not leave commands behind an ended task. A new owner task
            # takes the commands that still wait.
            with self._lock:
                self._task = None
                if any(self._queues.values()) and not self._loop.is_closed():
                    self._task = asyncio.run_coroutine_threadsafe(self._run(), self._loop)
            raise

    async def _acquire(self, request: _Request) -> None:
        kind = request.kind
        with self._lock:
            if kind in self._held:
                # The earlier connection of this kind is still out. Its release starts this one.
                self._deferred[kind].append(request)
                return
        remaining = request.deadline - monotonic()
        if request.abandoned or remaining <= 0:
            self._fail(request, TimeoutError(f"no {kind} connection by the deadline"))
            return
        try:
            connection, release = await self._open(remaining)
        except Exception as error:
            self._fail(request, error)
            return
        with self._lock:
            self._held[kind] = _Held(connection, release)
        with request.lock:
            deliver = not request.abandoned
            if deliver:
                request.delivered = True
                request.reply.set_result(connection)
        if not deliver:
            # Nobody waits for the connection, so its owner gives it back now. Nobody waits for
            # the result of that release either, so an error of it ends here, and the next
            # command runs.
            with suppress(Exception):
                await self._give_back(kind, broken=False)

    def _fail(self, request: _Request, error: BaseException) -> None:
        with request.lock:
            if not request.reply.done():
                request.reply.set_exception(error)

    async def _release_command(self, command: _Release) -> None:
        with self._lock:
            held = self._held.get(command.kind)
        if held is None or held.connection is not command.connection:
            if not command.reply.done():
                command.reply.set_result(None)
            return
        try:
            await self._give_back(command.kind, broken=command.broken)
        except Exception as error:
            if not command.reply.done():
                command.reply.set_exception(error)
            return
        if not command.reply.done():
            command.reply.set_result(None)

    async def _give_back(self, kind: str, *, broken: bool) -> None:
        """Release the held connection of `kind`, then let a deferred acquisition of it start."""
        with self._lock:
            held = self._held[kind]
        try:
            if broken and self._terminate is not None:
                with suppress(Exception):
                    await self._terminate(held.connection)
            await held.release()
        finally:
            with self._lock:
                del self._held[kind]
                while self._deferred[kind]:
                    self._queues[kind].appendleft(self._deferred[kind].pop())


# Opens the heartbeat executor within a timeout in seconds, and returns it with the callable that
# closes it.
HeartbeatConnection = tuple[SyncRowExecutor, Callable[[], None]]
HeartbeatAcquire = Callable[[float], HeartbeatConnection]


class ReservationSubscription:
    """One worker's use of a `HeartbeatReservation`. Closing it twice is harmless."""

    def __init__(self, reservation: HeartbeatReservation) -> None:
        self._reservation = reservation

    def close(self) -> None:
        self._reservation._unsubscribe(self)


class GroupedRound(Protocol):
    """A heartbeat round that waits in a `HeartbeatGroup`. Its deadline does not change."""

    @property
    def deadline(self) -> float: ...


class HeartbeatGroup:
    """The heartbeat rounds that share one transaction on the heartbeat connection of a pool.

    Each worker keeps its own heartbeat schedule, but the rounds of all workers on the pool share
    the transactions on the heartbeat connection. A round that finds no transaction in flight
    leads the next one. Just before the leader sends its heartbeat statement, it takes every
    waiting round whose deadline is not earlier than its own (`join`). These rounds join the
    transaction, and the leader gives each one its result. A round that did not join waits. When
    the transaction ends (`finish`), the waiting round with the earliest deadline leads the next
    one. So no round waits for more than the transaction in flight when it arrives.
    """

    def __init__(self, grace_seconds: float = 0.0) -> None:
        self._condition = Condition()
        self._grace = grace_seconds
        # The rounds that wait to lead or to join a transaction, in arrival order.
        self._waiting: list[GroupedRound] = []
        # The rounds that a leader took into its transaction. Each waits for its result.
        self._joined: set[GroupedRound] = set()
        self._leader: GroupedRound | None = None

    def wait(self, heartbeat_round: GroupedRound) -> Literal["lead", "joined", "expired"]:
        """Wait until `heartbeat_round` leads a transaction or joins one.

        "lead": the round must send the transaction, then call `finish`. "joined": the leader
        delivers the result of the round. "expired": the deadline of the round passed before it
        could lead or join, so it sent nothing.

        A leader that holds its transaction past its deadline plus the grace no longer blocks the
        others: its reservation also stops counting it as the holder of the connection.
        """
        with self._condition:
            self._waiting.append(heartbeat_round)
            try:
                while True:
                    if heartbeat_round in self._joined:
                        self._joined.discard(heartbeat_round)
                        return "joined"
                    now = monotonic()
                    if now >= heartbeat_round.deadline:
                        return "expired"
                    leader = self._leader
                    if leader is not None and now > leader.deadline + self._grace:
                        leader = self._leader = None
                    if leader is None and heartbeat_round is min(
                        self._waiting, key=lambda waiting: waiting.deadline
                    ):
                        self._leader = heartbeat_round
                        return "lead"
                    timeout = heartbeat_round.deadline - now
                    if leader is not None:
                        timeout = min(timeout, leader.deadline + self._grace - now)
                    self._condition.wait(timeout)
            finally:
                if heartbeat_round in self._waiting:
                    self._waiting.remove(heartbeat_round)
                self._condition.notify_all()

    def join(self, leader: GroupedRound) -> list[GroupedRound]:
        """Take the waiting rounds whose deadline is not earlier than the deadline of `leader`.

        They join the transaction of `leader`, in arrival order. The leader must deliver a result
        to each of them.
        """
        with self._condition:
            if self._leader is not leader:
                # The leader outlived its grace, so it takes no other round.
                return []
            joined = [waiting for waiting in self._waiting if waiting.deadline >= leader.deadline]
            for waiting in joined:
                self._waiting.remove(waiting)
                self._joined.add(waiting)
            self._condition.notify_all()
            return joined

    def finish(self, leader: GroupedRound) -> None:
        """End the transaction of `leader`, so the next waiting round can lead."""
        with self._condition:
            if self._leader is leader:
                self._leader = None
            self._condition.notify_all()


@dataclass(eq=False)
class _ReservationSubscriber:
    heartbeat_ms: int
    on_ready: Callable[[], None]


class HeartbeatReservation:
    """The heartbeat connection that every worker on one pool shares (ADR 0071, rules 3 to 7).

    The reservation holds one connection while it has subscribers. A heartbeat round takes it for
    the round and puts it back. A failed round gives it up, and the reservation starts the
    replacement at once. One acquirer thread at most runs at a time, so repeated timeouts never
    pile up connection requests or threads. It retries with a backoff capped at the shortest
    heartbeat interval of the subscribers, also while no task is active. When a connection
    arrives, every subscriber's ``on_ready`` runs, so dispatch claims again at once.

    The reservation is ready while it holds the connection or lends it to a round. A worker claims
    no task while its reservation is not ready.
    """

    def __init__(self, acquire: HeartbeatAcquire) -> None:
        self._acquire = acquire
        # The heartbeat rounds of the workers share the transactions on the connection.
        self.group = HeartbeatGroup(_LEND_GRACE_SECONDS)
        # One lock guards the whole connection lifecycle: acquisition, lending, and disposal.
        self._condition = Condition()
        # Disposals that run now. While one runs, no acquisition starts, and the reservation is
        # busy, so its hub stays the pool's hub.
        self._disposing = 0
        self._idle: HeartbeatConnection | None = None
        # The connection that a round holds, and the time after which the reservation stops
        # waiting for it. A round that hangs in its driver past that time no longer counts as a
        # holder: the reservation is not ready, and it opens a replacement.
        self._lent: HeartbeatConnection | None = None
        self._lend_until = 0.0
        self._acquirer: Thread | None = None
        # The rounds that wait for the connection, in arrival order. The first one takes it next,
        # so no worker on the pool waits behind the others for more than one turn each.
        self._waiters: deque[object] = deque()
        self._subscribers: dict[ReservationSubscription, _ReservationSubscriber] = {}
        # The deadlines of the workers that wait for the connection at startup. An acquisition
        # attempt may use the longest of them, so a slow connect can still finish at startup.
        self._startup_deadlines: list[float] = []
        self.last_error: BaseException | None = None
        # A configuration error, such as a pool without autocommit. A worker at startup sees it at
        # once. At runtime the acquirer keeps retrying, as for any other error.
        self._configuration_error: ValueError | None = None

    def subscribe(self, heartbeat_ms: int, on_ready: Callable[[], None]) -> ReservationSubscription:
        subscription = ReservationSubscription(self)
        with self._condition:
            self._subscribers[subscription] = _ReservationSubscriber(heartbeat_ms, on_ready)
            self._start_acquiring()
            self._condition.notify_all()
        return subscription

    def _unsubscribe(self, subscription: ReservationSubscription) -> None:
        idle: HeartbeatConnection | None = None
        with self._condition:
            if self._subscribers.pop(subscription, None) is None:
                return
            if not self._subscribers:
                idle, self._idle = self._idle, None
                if idle is not None:
                    self._disposing += 1
            self._condition.notify_all()
        if idle is not None:
            self._dispose(idle, broken=False)

    def ready(self) -> bool:
        with self._condition:
            return self._idle is not None or self._is_lent()

    def busy(self) -> bool:
        """True while a worker uses the reservation, or a connection, an acquisition, or a
        disposal remains."""
        with self._condition:
            return bool(
                self._subscribers
                or self._acquirer is not None
                or self._idle is not None
                or self._lent is not None
                or self._disposing
            )

    def _is_lent(self) -> bool:
        """True while a round holds the connection within its lend time. Hold the condition."""
        if self._lent is not None and monotonic() > self._lend_until:
            # The round outlived its deadline and the grace. Its connection is not usable now,
            # so the reservation forgets it and opens a replacement. The round disposes of it.
            self._lent = None
            self._start_acquiring()
            self._condition.notify_all()
        return self._lent is not None

    def wait_ready(self, deadline: float) -> bool:
        """Wait until the reservation holds its connection. False when `deadline` passed first.

        A configuration error of the pool raises at once.
        """
        with self._condition:
            self._startup_deadlines.append(deadline)
            try:
                self._configuration_error = None
                self._start_acquiring()
                self._condition.notify_all()
                while self._idle is None and not self._is_lent():
                    if self._configuration_error is not None:
                        raise self._configuration_error
                    remaining = deadline - monotonic()
                    if remaining <= 0:
                        return False
                    self._condition.wait(remaining)
                return True
            finally:
                self._startup_deadlines.remove(deadline)

    def take(self, deadline: float, minimum: float = 0.0) -> HeartbeatConnection | None:
        """Lend the connection to one round. None when it is not free by `deadline`.

        Rounds take the connection in arrival order. A round whose turn comes with less than
        `minimum` seconds before its deadline gets None and leaves the connection to the next
        round, because it could expire during a statement and lose the connection for every
        worker. The round must give the connection back through `put_back` or `lose`.
        """
        ticket = object()
        with self._condition:
            self._waiters.append(ticket)
            try:
                while True:
                    if self._idle is not None and self._waiters[0] is ticket:
                        now = monotonic()
                        if deadline - now < minimum:
                            return None
                        connection, self._idle = self._idle, None
                        self._lent = connection
                        self._lend_until = max(deadline, now) + _LEND_GRACE_SECONDS
                        return connection
                    lent = self._is_lent()
                    if not lent and self._idle is None:
                        self._start_acquiring()
                    now = monotonic()
                    remaining = deadline - now
                    if remaining <= 0:
                        return None
                    # Wake when the lend time ends too, so a hung round cannot hold this wait.
                    self._condition.wait(
                        min(remaining, self._lend_until - now) if lent else remaining
                    )
            finally:
                self._waiters.remove(ticket)
                # The next round in line may now take the connection.
                self._condition.notify_all()

    def put_back(self, connection: HeartbeatConnection) -> None:
        """Take back the connection of a round that left it usable.

        A round that outlived its lend time no longer holds the connection, so it is closed.
        """
        with self._condition:
            if self._lent is connection:
                self._lent = None
                if self._subscribers and self._idle is None:
                    self._idle, connection = connection, None  # type: ignore[assignment]
            if connection is not None:
                self._disposing += 1
            self._condition.notify_all()
        if connection is not None:
            self._dispose(connection, broken=False)

    def lose(self, connection: HeartbeatConnection) -> None:
        """Give up the connection of a failed round, and start its replacement at once."""
        with self._condition:
            if self._lent is connection:
                self._lent = None
            self._disposing += 1
            self._condition.notify_all()
        # The disposal ends with the start of the replacement.
        self._dispose(connection, broken=True)

    def _start_acquiring(self) -> None:
        """Start the acquirer if the reservation needs a connection. Hold the condition."""
        if self._acquirer is not None or not self._needs_connection():
            return
        acquirer = Thread(
            target=self._acquire_loop, name="workhorse-heartbeat-acquire", daemon=True
        )
        self._acquirer = acquirer
        try:
            acquirer.start()
        except BaseException:
            # A thread that never started cannot reset this, so a later call can try again.
            self._acquirer = None
            raise

    def _attempt_seconds(self) -> float:
        """The bound of one acquisition attempt. Hold the condition.

        At runtime it is the round bound of the shortest interval (ADR 0071, rule 5). While a
        worker waits at startup, it can be the rest of that worker's startup budget.
        """
        shortest = min(subscriber.heartbeat_ms for subscriber in self._subscribers.values())
        bound = heartbeat_round_bound_ms(shortest) / 1000
        if self._startup_deadlines:
            bound = max(bound, max(self._startup_deadlines) - monotonic())
        return bound

    def _needs_connection(self) -> bool:
        """True while a subscriber needs a connection that nobody holds. Hold the condition.

        No acquisition starts while a disposal runs.
        """
        return (
            self._idle is None
            and self._lent is None
            and not self._disposing
            and bool(self._subscribers)
        )

    def _dispose(self, connection: HeartbeatConnection, *, broken: bool) -> None:
        """Give up a connection that the caller counted in `_disposing`, then start a
        replacement if a worker still needs one."""
        try:
            _dispose(connection, broken=broken)
        finally:
            with self._condition:
                self._disposing -= 1
                self._start_acquiring()
                self._condition.notify_all()

    def _acquire_loop(self) -> None:
        backoff = _RECONNECT_INITIAL_SECONDS
        ready: list[Callable[[], None]] = []
        leftover: HeartbeatConnection | None = None
        try:
            while True:
                with self._condition:
                    if not self._needs_connection():
                        return
                    timeout = self._attempt_seconds()
                connection: HeartbeatConnection | None = None
                try:
                    connection = self._acquire(timeout)
                except ValueError as error:
                    with self._condition:
                        self.last_error = self._configuration_error = error
                        self._condition.notify_all()
                except Exception as error:
                    with self._condition:
                        self.last_error = error
                if connection is not None:
                    with self._condition:
                        if self._needs_connection():
                            self._idle = connection
                            self.last_error = self._configuration_error = None
                            ready = [s.on_ready for s in self._subscribers.values()]
                        else:
                            # Every worker left, or a round gave a connection back first. This
                            # thread owns the late connection and closes it, and the disposal
                            # counts before the acquirer ends.
                            leftover = connection
                            self._disposing += 1
                    return
                with self._condition:
                    if not self._needs_connection():
                        return
                    # No wait exceeds the shortest interval of the subscribers (ADR 0071, rule 6).
                    # The cap counts a worker that joined during the attempt, and it applies after
                    # the random factor, so the jitter stays below it.
                    cap = min(s.heartbeat_ms for s in self._subscribers.values()) / 1000
                    self._condition.wait(min(cap, backoff * random.uniform(0.9, 1.1)))
                backoff = min(cap, backoff * 2)
        finally:
            with self._condition:
                self._acquirer = None
                self._condition.notify_all()
            if leftover is not None:
                self._dispose(leftover, broken=False)
            for on_ready in ready:
                with suppress(Exception):
                    on_ready()


def _dispose(connection: HeartbeatConnection, *, broken: bool) -> None:
    executor, close = connection
    if broken:
        with suppress(Exception):
            discard_round_connection(executor)
    with suppress(Exception):
        close()


class ListenerSubscription(Protocol):
    def is_listening(self) -> bool: ...


# Opens one listener connection on the event loop, and returns it with the coroutine function that
# gives it back to the pool.
AsyncListenerOpen = Callable[[], Awaitable[tuple[Any, Callable[[], Awaitable[None]]]]]


@dataclass(eq=False)
class _AsyncSubscriber:
    queues: frozenset[str]
    wake: Callable[[], None]
    on_error: Callable[[BaseException], None] | None
    on_listening: Callable[[bool], None] | None


class AsyncNotificationSubscription:
    """One async worker's registration with an `AsyncTaskNotificationListener`."""

    def __init__(self, listener: AsyncTaskNotificationListener, subscriber: _AsyncSubscriber):
        self._listener = listener
        self._subscriber = subscriber

    def is_listening(self) -> bool:
        return self._listener.listening

    def close(self) -> asyncio.Task[None] | None:
        """Remove the registration. The last one returns the listener task, which then stops."""
        return self._listener._unsubscribe(self._subscriber)


class AsyncTaskNotificationListener:
    """One listener connection on the event loop of an async pool, shared by its workers.

    Every method runs on that event loop. The listener task holds its connection while the
    listener has subscribers. The last subscriber cancels the task. The hub's
    `AsyncConnectionOwner` gives the connection back to the pool. It holds at most one listener
    connection, and it starts no acquisition while the release of the earlier one runs, so the
    listener never holds two connections.

    `connections` is the owner of the hub, or a function that opens one listener connection. The
    listener then makes an owner of its own.
    """

    def __init__(self, driver: str, connections: AsyncConnectionOwner | AsyncListenerOpen) -> None:
        self._driver = driver
        self._owner = connections if isinstance(connections, AsyncConnectionOwner) else None
        self._open_connection = None if self._owner is not None else connections
        self._subscribers: dict[_AsyncSubscriber, None] = {}
        self._task: asyncio.Task[None] | None = None
        # The task whose LISTEN set `listening`. Only that task clears it.
        self._listening_task: asyncio.Task[None] | None = None
        # The worker whose departure stopped the listener. It receives the errors of the stop.
        self._stopped_by: list[_AsyncSubscriber] = []
        self.listening = False

    def subscribe(
        self,
        queues: Sequence[str],
        wake: Callable[[], None],
        on_error: Callable[[BaseException], None] | None = None,
        on_listening: Callable[[bool], None] | None = None,
    ) -> AsyncNotificationSubscription:
        subscriber = _AsyncSubscriber(frozenset(queues), wake, on_error, on_listening)
        self._subscribers[subscriber] = None
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._run())
        elif self.listening and on_listening is not None:
            self._call(on_listening, True)
        return AsyncNotificationSubscription(self, subscriber)

    def _unsubscribe(self, subscriber: _AsyncSubscriber) -> asyncio.Task[None] | None:
        if subscriber not in self._subscribers:
            return None
        del self._subscribers[subscriber]
        # A worker that leaves stops listening at once, whatever the listener does next.
        if subscriber.on_listening is not None:
            self._call(subscriber.on_listening, False)
        if self._subscribers or self._task is None:
            return None
        task, self._task = self._task, None
        self._stopped_by = [subscriber]
        task.cancel()
        return task

    def _set_listening(self, listening: bool) -> None:
        task = asyncio.current_task()
        if listening:
            self._listening_task = task
        elif self._listening_task is not task:
            # A task that stops after a newer task started must not clear the newer state.
            return
        else:
            self._listening_task = None
        self.listening = listening
        for subscriber in list(self._subscribers):
            if subscriber.on_listening is not None:
                self._call(subscriber.on_listening, listening)

    def _deliver(self, payload: str) -> None:
        for subscriber in list(self._subscribers):
            if payload == "*" or payload in subscriber.queues:
                self._call(subscriber.wake)

    def _wake_all(self) -> None:
        for subscriber in list(self._subscribers):
            self._call(subscriber.wake)

    def _report_error(self, error: BaseException) -> None:
        for subscriber in list(self._subscribers) or self._stopped_by:
            if subscriber.on_error is not None:
                self._call(subscriber.on_error, error)

    @staticmethod
    def _call(callback: Callable[..., object], *arguments: object) -> None:
        # A callback that raises must not end the listener, which would stop every worker's wakes.
        with suppress(Exception):
            callback(*arguments)

    def busy(self) -> bool:
        """True while a task listens, or the owner still holds or gives back a connection."""
        return self._task is not None or (self._owner is not None and self._owner.busy())

    def _connections(self) -> AsyncConnectionOwner:
        if self._owner is None:
            open_connection = cast(AsyncListenerOpen, self._open_connection)

            async def open_listener(_timeout: float) -> tuple[Any, Callable[[], Awaitable[None]]]:
                return await open_connection()

            self._owner = AsyncConnectionOwner(asyncio.get_running_loop(), open_listener)
        return self._owner

    async def _run(self) -> None:
        me = asyncio.current_task()
        owner = self._connections()
        reconnect_seconds = _RECONNECT_INITIAL_SECONDS
        while self._task is me and self._subscribers:
            connection: Any | None = None
            cancelled = False
            try:
                # The owner starts this acquisition only after the earlier listener connection,
                # also one of a stopped task, is back in the pool.
                connection = await owner.acquire_async(
                    LISTENER, monotonic() + LISTENER_ACQUIRE_SECONDS
                )
                if self._driver == "psycopg":
                    await self._listen_psycopg(connection)
                else:
                    await self._listen_asyncpg(connection)
                reconnect_seconds = _RECONNECT_INITIAL_SECONDS
            except asyncio.CancelledError:
                cancelled = True
            except BaseException as error:
                self._report_error(error)
                self._wake_all()
            finally:
                if self.listening and self._listening_task is me:
                    self._set_listening(False)
                if connection is not None:
                    cancelled = await self._release(owner, connection) or cancelled
            if cancelled:
                raise asyncio.CancelledError
            # Reconnect only for the subscribers this task still serves.
            if self._task is not me or not self._subscribers:
                return
            await asyncio.sleep(reconnect_seconds * random.uniform(0.9, 1.1))
            reconnect_seconds = min(_RECONNECT_MAX_SECONDS, reconnect_seconds * 2)

    async def _release(self, owner: AsyncConnectionOwner, connection: Any) -> bool:
        """Give the connection to the owner, and wait for its release within the cleanup bound.

        True when this task was cancelled meanwhile. A cancellation does not cut the wait short,
        and the caller raises it afterwards. A release that outlives the bound continues in the
        owner, which keeps the connection until it ends.
        """
        loop = asyncio.get_running_loop()
        released = asyncio.wrap_future(owner.release_soon(LISTENER, connection))
        deadline = loop.time() + CLEANUP_SECONDS
        cancelled = False
        while not released.done():
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            try:
                await asyncio.wait((released,), timeout=remaining)
            except asyncio.CancelledError:
                cancelled = True
        if released.done():
            self._report_release(released)
        else:
            released.add_done_callback(self._report_release)
        return cancelled

    def _report_release(self, release: asyncio.Future[None]) -> None:
        if not release.cancelled() and release.exception() is not None:
            self._report_error(cast(BaseException, release.exception()))

    async def _listen_psycopg(self, connection: Any) -> None:
        if getattr(connection, "autocommit", False) is not True:
            raise ValueError("Notification connection must use autocommit mode")
        await connection.execute(f"LISTEN {_CHANNEL}")
        self._set_listening(True)
        self._wake_all()
        while True:
            async for notification in connection.notifies(
                timeout=_ASYNC_READ_SECONDS, stop_after=1
            ):
                self._deliver(notification.payload)

    async def _listen_asyncpg(self, connection: Any) -> None:
        if connection.is_in_transaction():
            raise ValueError("Notification connection must not have an active transaction")

        def wake(_connection: object, _pid: int, _channel: str, payload: str) -> None:
            self._deliver(payload)

        await connection.add_listener(_CHANNEL, wake)
        try:
            self._set_listening(True)
            self._wake_all()
            # asyncpg reports a closed connection only through is_closed, so the task polls it.
            while not connection.is_closed():  # noqa: ASYNC110
                await asyncio.sleep(_ASYNC_READ_SECONDS)
        finally:
            # The last subscriber cancels this task, and asyncpg warns when a pooled connection
            # returns with a callback. A failed UNLISTEN leaves the release to the pool's reset.
            try:
                await connection.remove_listener(_CHANNEL, wake)
            except Exception as error:
                self._report_error(error)


class PoolHub:
    """The shared listener and the shared heartbeat reservation of one pool.

    ``loop`` is the event loop of an async pool, and None for a sync pool. The listener is a
    `SharedTaskNotificationListener` for a sync pool and an `AsyncTaskNotificationListener` for an
    async pool.
    """

    def __init__(
        self,
        label: str,
        listener: Any,
        heartbeat: HeartbeatReservation,
        loop: asyncio.AbstractEventLoop | None = None,
        owner: AsyncConnectionOwner | None = None,
    ) -> None:
        self.label = label
        self.listener = listener
        self.heartbeat = heartbeat
        self.loop = loop
        # The one owner of the connections of an async hub. A sync hub has none.
        self.owner = owner

    def busy(self) -> bool:
        """True while a resource of the hub still runs, so the hub must stay the pool's hub."""
        listener_busy = getattr(self.listener, "busy", None)
        return (
            self.heartbeat.busy()
            or (callable(listener_busy) and bool(listener_busy()))
            or (self.owner is not None and self.owner.busy())
        )

    def close(self) -> None:
        """Stop the owner task of an idle hub that the registry dropped."""
        if self.owner is not None:
            self.owner.close()


@dataclass(eq=False)
class _Entry:
    pool: Callable[[], object | None]
    hub: PoolHub
    attached: int


class PoolRegistry:
    """The hubs of one domain, keyed by the identity of the pool object.

    An entry lives while a worker is attached, and also while its resources still stop, so a
    restart reuses the same hub and never holds two listener connections. Each entry holds only a
    weak reference to its pool. The registry also remembers the event loop of each async pool for
    the life of the pool.
    """

    def __init__(self, domain: str) -> None:
        self._domain = domain
        self._lock = Lock()
        self._entries: dict[int, _Entry] = {}
        self._loops: dict[int, tuple[Callable[[], object | None], Callable[[], Any]]] = {}
        # Keys of collected pools. A weakref callback can run during any allocation, also under
        # the lock, so it only appends here, and the registry purges the keys under its lock.
        self._collected: deque[int] = deque()

    def attach(
        self,
        pool: object,
        create: Callable[[Callable[[], Any]], PoolHub],
        loop: asyncio.AbstractEventLoop | None = None,
    ) -> PoolHub:
        """The hub of `pool`, attached once more. `create` builds it from a weak pool reference.

        A worker on another event loop than the pool's refuses to start.
        """
        key = id(pool)
        with self._lock:
            self._purge()
            if loop is not None:
                owner = self._remembered_loop(key, pool)
                if owner is not None and owner is not loop and not owner.is_closed():
                    raise RuntimeError(self._wrong_loop(pool))
                self._loops[key] = (
                    weak_pool(pool, lambda: self._forget(key)),
                    weak_pool(loop),
                )
            entry = self._entries.get(key)
            if entry is not None and (
                entry.pool() is not pool
                or (
                    entry.attached <= 0
                    and entry.hub.loop is not None
                    and entry.hub.loop.is_closed()
                )
            ):
                del self._entries[key]
                entry = None
            if entry is not None:
                if entry.hub.loop is not None and entry.hub.loop is not loop:
                    raise RuntimeError(self._wrong_loop(pool))
                entry.attached += 1
                return entry.hub
            pool_ref = weak_pool(pool, lambda: self._forget(key))
            hub = create(pool_ref)
            self._entries[key] = _Entry(pool_ref, hub, 1)
            return hub

    def remembered_loop(self, pool: object) -> asyncio.AbstractEventLoop | None:
        """The event loop that the first worker of `pool` ran on, while the pool lives."""
        with self._lock:
            self._purge()
            return cast(asyncio.AbstractEventLoop | None, self._remembered_loop(id(pool), pool))

    def detach(self, hub: PoolHub) -> None:
        """Detach one worker. A hub whose resources still stop stays the pool's hub."""
        with self._lock:
            for entry in self._entries.values():
                if entry.hub is hub:
                    entry.attached -= 1
                    break
            self._purge()

    def hubs(self) -> list[PoolHub]:
        """The hubs with an attached worker, for tests."""
        with self._lock:
            self._purge()
            return [entry.hub for entry in self._entries.values() if entry.attached > 0]

    def _wrong_loop(self, pool: object) -> str:
        return (
            f"AsyncWorker cannot start: the {self._domain} pool {pool_label(pool)} belongs to "
            "another event loop. Run every worker of one pool on the event loop of that pool."
        )

    def _remembered_loop(self, key: int, pool: object) -> Any:
        """Hold the lock."""
        remembered = self._loops.get(key)
        if remembered is None or remembered[0]() is not pool:
            return None
        return remembered[1]()

    def _forget(self, key: int) -> None:
        self._collected.append(key)

    def _purge(self) -> None:
        """Remove the entries of collected pools and of settled hubs. Hold the lock."""
        while self._collected:
            key = self._collected.popleft()
            entry = self._entries.get(key)
            if entry is not None and entry.pool() is None:
                del self._entries[key]
            remembered = self._loops.get(key)
            if remembered is not None and remembered[0]() is None:
                del self._loops[key]
        for key, entry in list(self._entries.items()):
            if entry.attached <= 0 and not entry.hub.busy():
                del self._entries[key]
                entry.hub.close()


SYNC_HUBS = PoolRegistry("psycopg")
ASYNC_PSYCOPG_HUBS = PoolRegistry("async psycopg")
ASYNCPG_HUBS = PoolRegistry("asyncpg")
