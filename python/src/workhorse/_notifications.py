from __future__ import annotations

import random
from collections.abc import Callable, Iterator, Sequence
from threading import Event, Thread
from typing import TYPE_CHECKING, Any, Protocol

_CHANNEL = "workhorse_jobs"
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


class JobNotificationListener:
    def __init__(
        self,
        connection_factory: NotificationConnectionFactory,
        queues: Sequence[str],
        wake: Callable[[], None],
        on_error: Callable[[BaseException], None] | None = None,
        query_connection: object | None = None,
    ) -> None:
        self._connection_factory = connection_factory
        self._queues = frozenset(queues)
        self._wake = wake
        self._on_error = on_error
        self._query_connection = query_connection
        self._stop = Event()
        self._listening = Event()
        self._thread: Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("Notification listener is already running")
        self._stop.clear()
        self._thread = Thread(
            target=self._run,
            name="workhorse-notification-listener",
            daemon=True,
        )
        self._thread.start()

    def is_listening(self) -> bool:
        return self._listening.is_set()

    def close(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(_READ_TIMEOUT_SECONDS * 2)
        self._thread = None

    def _report_error(self, error: BaseException) -> None:
        if self._on_error is not None:
            self._on_error(error)

    def _run(self) -> None:
        reconnect_seconds = _RECONNECT_INITIAL_SECONDS
        while not self._stop.is_set():
            connection: NotificationConnection | None = None
            try:
                candidate = self._connection_factory()
                if candidate is self._query_connection:
                    raise ValueError("Notification connection must be separate from the worker")
                connection = candidate
                if self._stop.is_set():
                    return
                if connection.autocommit is not True:
                    raise ValueError("Notification connection must use autocommit mode")
                connection.execute(f"LISTEN {_CHANNEL}")
                reconnect_seconds = _RECONNECT_INITIAL_SECONDS
                self._listening.set()
                self._wake()
                while not self._stop.is_set():
                    for notification in connection.notifies(
                        timeout=_READ_TIMEOUT_SECONDS,
                        stop_after=1,
                    ):
                        if notification.payload == "*" or notification.payload in self._queues:
                            self._wake()
            except BaseException as error:
                self._listening.clear()
                self._report_error(error)
                self._wake()
            finally:
                self._listening.clear()
                if connection is not None:
                    try:
                        connection.close()
                    except BaseException as error:
                        self._report_error(error)

            if self._stop.is_set():
                return
            jittered = reconnect_seconds * random.uniform(0.9, 1.1)
            self._stop.wait(jittered)
            reconnect_seconds = min(_RECONNECT_MAX_SECONDS, reconnect_seconds * 2)
