"""Bounded waits for contracts the product satisfies eventually rather than immediately.

A test that sleeps for a fixed delay and then asserts once encodes a guess about how fast the
machine is. The guess holds on a developer laptop and fails on a loaded CI runner, so the test
reports a product failure that a targeted rerun cannot reproduce. These helpers poll instead:
they return as soon as the condition holds and fail with the description once the budget is gone.

Use them only where the contract really is eventual, such as a lease expiring, a retry backoff
elapsing, or a durable sleep waking. A contract that must already hold deserves a plain assert.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from time import monotonic, sleep

DEFAULT_TIMEOUT_S = 5.0
_POLL_S = 0.005


def eventually(
    condition: Callable[[], bool],
    description: str,
    *,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> None:
    """Poll until the condition holds, or fail naming what never happened."""
    deadline = monotonic() + timeout_s
    while True:
        if condition():
            return
        if monotonic() >= deadline:
            raise AssertionError(f"{description} within {timeout_s:g}s")
        sleep(_POLL_S)


async def eventually_async(
    condition: Callable[[], Awaitable[bool]],
    description: str,
    *,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> None:
    """Await the condition repeatedly until it holds, or fail naming what never happened."""
    deadline = monotonic() + timeout_s
    while True:
        if await condition():
            return
        if monotonic() >= deadline:
            raise AssertionError(f"{description} within {timeout_s:g}s")
        await asyncio.sleep(_POLL_S)
