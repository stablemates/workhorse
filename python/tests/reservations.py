"""Give a worker its heartbeat reservation outside a run, for tests that drive rounds directly."""

from __future__ import annotations

import workhorse._pool_hub as pool_hub_module
from workhorse._pool_hub import ReservationSubscription
from workhorse.worker import Worker


def reserve(worker: Worker) -> ReservationSubscription:
    """Reserve the worker's heartbeat connection and start a run generation, as a startup does.

    The worker must have a private heartbeat executor factory. The reservation wakes the worker's
    dispatcher when a replacement connection arrives. Close the subscription to give the
    connection back.
    """
    reservation = worker._heartbeat_reservation(None)
    assert reservation is not None
    subscription = reservation.subscribe(worker.heartbeat_ms, worker._wake_dispatcher)
    # The deadline uses the reservation's own clock. A test can replace that clock with a fake one,
    # and a deadline from another clock would then pass at once or never.
    deadline = pool_hub_module.monotonic() + 5
    assert reservation.wait_ready(deadline), "the heartbeat connection never opened"
    with worker._state_lock:
        worker._run_generation += 1
        worker._reservation = reservation
    return subscription
