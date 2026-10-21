from __future__ import annotations

import random
from collections.abc import Callable, Iterator, Sequence
from contextlib import suppress
from dataclasses import dataclass
from threading import Event, Lock, Thread
from typing import TYPE_CHECKING, Any, Protocol

_CHANNEL = "workhorse_tasks"
_RECONNECT_INITIAL_SECONDS = 0.1
_RECONNECT_MAX_SECONDS = 5.0
_READ_TIMEOUT_SECONDS = 0.1


if TYPE_CHECKING:
    import psycopg

    NotificationConnection = psycopg.Connection[Any]
else:

    class Notification(Protocol):
        payload: str

    class NotificationConnection(Protocol):
        autocommit: bool

        def execute(self, query: str) -> object: ...

        def notifies(
            self, *, timeout: float | None = None, stop_after: int | None = None
        ) -> Iterator[Notification]: ...

        def close(self) -> None: ...


NotificationConnectionFactory = Callable[[], NotificationConnection]


@dataclass(eq=False, frozen=True)
class _Subscriber:
    queues: frozenset[str]
    wake: Callable[[], None]
    on_error: Callable[[BaseException], None] | None
    on_listening: Callable[[bool], None] | None


class NotificationSubscription:
    """One worker's registration with a shared listener. Closing it twice is harmless."""

    def __init__(self, listener: SharedTaskNotificationListener, subscriber: _Subscriber) -> None:
        self._listener = listener
        self._subscriber = subscriber

    def is_listening(self) -> bool:
        return self._listener.is_listening()

    def close(self) -> None:
        self._listener.unsubscribe(self._subscriber)


class SharedTaskNotificationListener:
    """One listener connection that wakes every worker subscribed on one pool (ADR 0071).

    The listener holds its connection, which runs ``LISTEN workhorse_tasks``, while it has
    subscribers. A notification names a queue, or ``*`` for every queue, and wakes each subscriber
    whose queues match. A lost connection reconnects with a jittered backoff, and each worker polls
    meanwhile. Subscribing never waits: a listener that still stops, perhaps in a blocked connection
    request, keeps its thread for the new subscriber. So one listener never holds two connections.
    """

    def __init__(
        self,
        connection_factory: NotificationConnectionFactory,
        query_connection: object | None = None,
    ) -> None:
        self._connection_factory = connection_factory
        self._query_connection = query_connection
        self._lock = Lock()
        self._subscribers: dict[_Subscriber, None] = {}
        self._running = False
        self._listening = Event()
        self._stopped = Event()
        self._stopped.set()
        # Ends a reconnect wait when the last subscriber leaves.
        self._interrupt = Event()
        # The worker whose departure stopped the listener. It receives the errors of the stop.
        self._stopped_by: list[_Subscriber] = []

    def subscribe(
        self,
        queues: Sequence[str],
        wake: Callable[[], None],
        on_error: Callable[[BaseException], None] | None = None,
        on_listening: Callable[[bool], None] | None = None,
    ) -> NotificationSubscription:
        subscriber = _Subscriber(frozenset(queues), wake, on_error, on_listening)
        with self._lock:
            self._subscribers[subscriber] = None
            start = not self._running
            if start:
                self._running = True
                self._stopped.clear()
                self._interrupt.clear()
        if start:
            Thread(target=self._run, name="workhorse-notification-listener", daemon=True).start()
        elif self._listening.is_set() and on_listening is not None:
            self._call(on_listening, True)
        return NotificationSubscription(self, subscriber)

    def unsubscribe(self, subscriber: _Subscriber) -> None:
        """Remove `subscriber`. The last one stops the listener, which closes its connection.

        The wait for that close is bounded, so a blocked connection request cannot hold a stop.
        """
        with self._lock:
            if subscriber not in self._subscribers:
                return
            del self._subscribers[subscriber]
            last = not self._subscribers
            if last:
                self._stopped_by = [subscriber]
                self._interrupt.set()
        # A worker that leaves stops listening at once, whatever the listener does next.
        if subscriber.on_listening is not None:
            self._call(subscriber.on_listening, False)
        if last:
            self._stopped.wait(_READ_TIMEOUT_SECONDS * 2)

    def is_listening(self) -> bool:
        return self._listening.is_set()

    def busy(self) -> bool:
        """True while the listener thread runs, perhaps still closing its connection."""
        with self._lock:
            return self._running

    def _active(self) -> bool:
        with self._lock:
            return bool(self._subscribers)

    def _snapshot(self) -> list[_Subscriber]:
        with self._lock:
            return list(self._subscribers)

    def _run(self) -> None:
        while True:
            try:
                self._listen_while_subscribed()
            finally:
                with self._lock:
                    done = not self._subscribers
                    if done:
                        self._running = False
                        self._stopped.set()
            if done:
                return

    def _set_listening(self, listening: bool) -> None:
        if listening:
            self._listening.set()
        else:
            self._listening.clear()
        for subscriber in self._snapshot():
            if subscriber.on_listening is not None:
                self._call(subscriber.on_listening, listening)

    def _deliver(self, payload: str) -> None:
        for subscriber in self._snapshot():
            if payload == "*" or payload in subscriber.queues:
                self._call(subscriber.wake)

    def _wake_all(self) -> None:
        for subscriber in self._snapshot():
            self._call(subscriber.wake)

    def _report_error(self, error: BaseException) -> None:
        with self._lock:
            audience = list(self._subscribers) or list(self._stopped_by)
        for subscriber in audience:
            if subscriber.on_error is not None:
                self._call(subscriber.on_error, error)

    @staticmethod
    def _call(callback: Callable[..., object], *arguments: object) -> None:
        # A callback that raises must not end the listener, which would stop every worker's wakes.
        with suppress(Exception):
            callback(*arguments)

    def _listen_while_subscribed(self) -> None:
        reconnect_seconds = _RECONNECT_INITIAL_SECONDS
        while self._active():
            connection: NotificationConnection | None = None
            try:
                candidate = self._connection_factory()
                if candidate is self._query_connection:
                    raise ValueError("Notification connection must be separate from the worker")
                connection = candidate
                if not self._active():
                    return
                if connection.autocommit is not True:
                    raise ValueError("Notification connection must use autocommit mode")
                connection.execute(f"LISTEN {_CHANNEL}")
                reconnect_seconds = _RECONNECT_INITIAL_SECONDS
                self._set_listening(True)
                self._wake_all()
                while self._active():
                    for notification in connection.notifies(
                        timeout=_READ_TIMEOUT_SECONDS,
                        stop_after=1,
                    ):
                        self._deliver(notification.payload)
            except BaseException as error:
                self._set_listening(False)
                self._report_error(error)
                self._wake_all()
            finally:
                if self._listening.is_set():
                    self._set_listening(False)
                if connection is not None:
                    try:
                        connection.close()
                    except BaseException as error:
                        self._report_error(error)

            if not self._active():
                return
            jittered = reconnect_seconds * random.uniform(0.9, 1.1)
            if self._interrupt.wait(jittered):
                self._interrupt.clear()
            reconnect_seconds = min(_RECONNECT_MAX_SECONDS, reconnect_seconds * 2)


class TaskNotificationListener:
    """A shared listener with one subscriber, for a caller that owns its own connection factory."""

    def __init__(
        self,
        connection_factory: NotificationConnectionFactory,
        queues: Sequence[str],
        wake: Callable[[], None],
        on_error: Callable[[BaseException], None] | None = None,
        query_connection: object | None = None,
    ) -> None:
        self._listener = SharedTaskNotificationListener(connection_factory, query_connection)
        self._queues = tuple(queues)
        self._wake = wake
        self._on_error = on_error
        self._subscription: NotificationSubscription | None = None

    def start(self) -> None:
        if self._subscription is not None:
            raise RuntimeError("Notification listener is already running")
        self._subscription = self._listener.subscribe(self._queues, self._wake, self._on_error)

    def is_listening(self) -> bool:
        return self._listener.is_listening()

    def close(self) -> None:
        subscription, self._subscription = self._subscription, None
        if subscription is not None:
            subscription.close()
