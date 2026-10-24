"""Warn once when a worker statement still waits after the stop budget."""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager, suppress
from time import monotonic
from typing import Literal

WatchedStatement = Literal["maintenance", "claim"]


class StatementWatch:
    """Calls ``warn`` once for each maintenance pass or claim that waits longer than the budget.

    One thread serves every statement of a worker. It starts with the first statement and ends
    after it watched nothing for at least one budget, so an idle worker holds no thread and a busy
    worker starts no thread for each claim. The warning does not end, fail, or delay the statement.
    """

    def __init__(
        self, budget_seconds: float, warn: Callable[[WatchedStatement, int], None]
    ) -> None:
        self._budget_seconds = budget_seconds
        self._warn = warn
        self._condition = threading.Condition()
        # Each statement in flight that has not warned yet: its kind and its start time.
        self._watched: dict[int, tuple[WatchedStatement, float]] = {}
        self._next_token = 0
        self._thread: threading.Thread | None = None

    @contextmanager
    def watch(self, statement: WatchedStatement) -> Iterator[None]:
        with self._condition:
            token = self._next_token
            self._next_token += 1
            self._watched[token] = (statement, monotonic())
            if self._thread is None:
                self._thread = threading.Thread(
                    target=self._run, name="workhorse-statement-watch", daemon=True
                )
                self._thread.start()
            elif len(self._watched) == 1:
                # The thread waits without a statement. A later statement is due later than the
                # earliest one, so only this first one must wake it.
                self._condition.notify()
        try:
            yield
        finally:
            with self._condition:
                self._watched.pop(token, None)

    def _run(self) -> None:
        while True:
            with self._condition:
                now = monotonic()
                due: list[tuple[WatchedStatement, float]] = []
                next_due: float | None = None
                for token, (statement, started_at) in list(self._watched.items()):
                    if now - started_at >= self._budget_seconds:
                        del self._watched[token]
                        due.append((statement, started_at))
                    elif next_due is None or started_at + self._budget_seconds < next_due:
                        next_due = started_at + self._budget_seconds
                if not due:
                    if next_due is not None:
                        self._condition.wait(next_due - now)
                        continue
                    self._condition.wait(self._budget_seconds)
                    if not self._watched:
                        self._thread = None
                        return
                    continue
            for statement, started_at in due:
                # Each record measures its own wait, so a slow log call does not age the next one.
                # A failed log record must not fail the statement or end the watch.
                with suppress(Exception):
                    self._warn(statement, round((monotonic() - started_at) * 1_000))
