from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from threading import Event
from time import monotonic

from workhorse._notifications import JobNotificationListener


@dataclass
class _Notification:
    payload: str


class _Connection:
    autocommit = True

    def __init__(self, notifications: list[str], *, fail_after_read: bool = False) -> None:
        self.notifications = notifications
        self.fail_after_read = fail_after_read
        self.listened = Event()
        self.closed = False
        self.closed_event = Event()

    def execute(self, query: str) -> None:
        assert query == "LISTEN workhorse_jobs"
        self.listened.set()

    def notifies(self, *, timeout: float, stop_after: int | None = None) -> Iterator[_Notification]:
        assert timeout > 0
        assert stop_after == 1
        if self.notifications:
            yield _Notification(self.notifications.pop(0))
        elif self.fail_after_read:
            raise RuntimeError("listener disconnected")

    def close(self) -> None:
        self.closed = True
        self.closed_event.set()


def test_listener_wakes_only_for_matching_queues_and_wildcard() -> None:
    connection = _Connection(["other", "mail", "*"])
    wake_count = 0
    three_reads = Event()

    def wake() -> None:
        nonlocal wake_count
        wake_count += 1
        if wake_count == 3:  # connect, matching queue, wildcard
            three_reads.set()

    listener = JobNotificationListener(lambda: connection, ["mail"], wake)
    listener.start()
    assert three_reads.wait(timeout=1)
    listener.close()

    assert wake_count == 3
    assert connection.closed is True


def test_listener_wakes_on_reconnect_after_a_read_failure() -> None:
    first = _Connection([], fail_after_read=True)
    second = _Connection([])
    connections = iter([first, second])
    wake_count = 0
    listening_states: list[bool] = []
    reconnected = Event()

    def wake() -> None:
        nonlocal wake_count
        wake_count += 1
        listening_states.append(listener.is_listening())
        if wake_count == 3:  # first connect, disconnect, second connect
            reconnected.set()

    listener = JobNotificationListener(lambda: next(connections), ["default"], wake)
    listener.start()
    assert reconnected.wait(timeout=1)
    listener.close()

    assert first.closed is True
    assert second.closed is True
    assert listening_states == [True, False, True]


def test_listener_close_does_not_wait_for_a_blocked_connection_factory() -> None:
    factory_started = Event()
    release_factory = Event()
    connection = _Connection([])

    def blocked_factory() -> _Connection:
        factory_started.set()
        assert release_factory.wait(timeout=5)
        return connection

    listener = JobNotificationListener(blocked_factory, ["default"], lambda: None)
    listener.start()
    assert factory_started.wait(timeout=1)

    started_at = monotonic()
    listener.close()
    assert monotonic() - started_at < 0.5

    release_factory.set()
    assert connection.closed_event.wait(timeout=1)
