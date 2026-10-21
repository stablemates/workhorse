"""Run the Python probe of the connection budget benchmark (SM-1566).

The probe starts W workers on one pool. A task whose payload has ``handlerMs`` returns after that
time; any other task holds its slot until SIGTERM. Every handler returns at SIGTERM, so the stop
time measures the SDK. The first argument selects the variant: ``sync`` runs ``Worker`` on a
psycopg pool, ``async`` runs ``AsyncWorker.from_psycopg``, and ``asyncpg`` runs
``AsyncWorker.from_asyncpg``. ``scripts/benchmark-connection-budget.ts`` starts the probe and reads
the ``WH_BENCH_*`` variables below. Nothing in CI runs it.

The workers have no shutdown grace. Like ``run_worker_process``, the probe exits with status 1
when the workers have not stopped ``WH_BENCH_SHUTDOWN_GRACE_MS`` after SIGTERM.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import threading
import time
from contextlib import suppress
from typing import Any

import asyncpg  # type: ignore[import-untyped]
from psycopg_pool import AsyncConnectionPool, ConnectionPool

from workhorse import AsyncHandlerContext, AsyncWorker, HandlerContext, Json, Worker


def setting(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def count(name: str) -> int:
    value = int(setting(name))
    if value < 1:
        raise SystemExit(f"{name} must be a positive integer")
    return value


def optional_count(name: str) -> int | None:
    """Return a positive integer from an optional variable, or None when it is empty."""
    return count(name) if os.environ.get(name) else None


_output = threading.Lock()


def emit(event: dict[str, Json]) -> None:
    with _output:
        sys.stdout.write(json.dumps(event) + "\n")
        sys.stdout.flush()


QUEUE = setting("WH_BENCH_QUEUE")
TASK_TYPE = setting("WH_BENCH_TASK_TYPE")
WORKERS = count("WH_BENCH_WORKERS")
CONCURRENCY = count("WH_BENCH_CONCURRENCY")
POOL_SIZE = count("WH_BENCH_POOL_SIZE")
HEARTBEAT_MS = count("WH_BENCH_HEARTBEAT_MS")
LEASE_MS = count("WH_BENCH_LEASE_MS")
DATABASE_URL = setting("WH_BENCH_DATABASE_URL")
APPLICATION_NAME = setting("WH_BENCH_APPLICATION_NAME")
POLL_MS = optional_count("WH_BENCH_POLL_MS")
SHUTDOWN_GRACE_MS = count("WH_BENCH_SHUTDOWN_GRACE_MS")


def started(variant: str) -> dict[str, Json]:
    """Return the event that names the settings the probe applied."""
    return {
        "event": "started",
        "sdk": f"python-{variant}",
        "workers": WORKERS,
        "pollMs": POLL_MS,
        "shutdownGraceMs": SHUTDOWN_GRACE_MS,
        "grace": "probe exit",
    }


def handler_ms(payload: Any) -> int | None:
    """Return the handler time that the payload of a task carries, or None for a held task."""
    value = payload.get("handlerMs") if isinstance(payload, dict) else None
    return value if isinstance(value, int) else None


def arm_shutdown_deadline() -> None:
    """Exit with status 1 if the workers have not stopped within the grace."""

    def expire() -> None:
        emit({"event": "shutdown_incomplete", "shutdownGraceMs": SHUTDOWN_GRACE_MS})
        os._exit(1)

    deadline = threading.Timer(SHUTDOWN_GRACE_MS / 1000, expire)
    deadline.daemon = True
    deadline.start()


def psycopg_pool_state(stats: dict[str, int]) -> dict[str, Json]:
    """Return the pool state that ``get_stats()`` reports for a psycopg pool."""
    total = stats.get("pool_size", 0)
    idle = stats.get("pool_available", 0)
    return {
        "event": "pool",
        "total": total,
        "idle": idle,
        "checkedOut": total - idle,
        "waiting": stats.get("requests_waiting", 0),
        "max": stats.get("pool_max", POOL_SIZE),
    }


def asyncpg_pool_state(pool: Any) -> dict[str, Json]:
    """Return the pool state of an asyncpg pool, which counts no waiters."""
    total = int(pool.get_size())
    idle = int(pool.get_idle_size())
    return {
        "event": "pool",
        "total": total,
        "idle": idle,
        "checkedOut": total - idle,
        "waiting": None,
        "max": int(pool.get_max_size()),
    }


def run_sync() -> None:
    stopping = threading.Event()
    release = threading.Event()

    def handler(payload: Any, context: HandlerContext) -> Json:
        duration_ms = handler_ms(payload)
        if duration_ms is not None:
            # The handler returns after its time, when the probe stops, or when the worker cancels
            # the attempt.
            deadline = time.monotonic() + duration_ms / 1000
            while not release.is_set() and not context.cancellation.cancelled:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                release.wait(min(remaining, 0.05))
            return None
        # The handler holds its slot until the probe stops or the worker cancels the attempt.
        while not release.wait(0.05) and not context.cancellation.cancelled:
            pass
        return None

    def on_term(_signum: int, _frame: object) -> None:
        stopping.set()

    signal.signal(signal.SIGTERM, on_term)
    # min_size=0 opens a connection only when the SDK asks for one, so the count shows its need.
    with ConnectionPool(
        DATABASE_URL,
        min_size=0,
        max_size=POOL_SIZE,
        kwargs={"autocommit": True, "application_name": APPLICATION_NAME},
    ) as pool:
        workers: list[Worker] = []
        threads: list[threading.Thread] = []
        for index in range(WORKERS):
            try:
                worker = Worker(
                    pool,
                    queue=QUEUE,
                    worker_id=f"wh-bench-python-sync-{os.getpid()}-{index}",
                    concurrency=CONCURRENCY,
                    heartbeat_ms=HEARTBEAT_MS,
                    lease_ms=LEASE_MS,
                    poll_ms=POLL_MS,
                ).handle(TASK_TYPE, handler)
            except Exception as error:
                emit({"event": "worker_error", "worker": index, "error": repr(error)})
                continue

            def run(worker: Worker = worker, index: int = index) -> None:
                try:
                    worker.run()
                except Exception as error:
                    emit({"event": "worker_error", "worker": index, "error": repr(error)})

            workers.append(worker)
            threads.append(threading.Thread(target=run, name=f"wh-bench-worker-{index}"))
        for thread in threads:
            thread.start()
        emit(started("sync"))
        # The pool state, seen from inside the process, every 250 ms until SIGTERM.
        while not stopping.wait(0.25):
            emit(psycopg_pool_state(pool.get_stats()))
        arm_shutdown_deadline()
        # Stop claims first, then let the handlers return.
        for worker in workers:
            worker.stop()
        release.set()
        for thread in threads:
            thread.join()
    emit({"event": "stopped"})


async def run_async(variant: str) -> None:
    release = asyncio.Event()

    async def handler(payload: Any, context: AsyncHandlerContext) -> Json:
        duration_ms = handler_ms(payload)
        if duration_ms is not None:
            # The handler returns after its time, when the probe stops, or when the worker cancels
            # the attempt.
            deadline = time.monotonic() + duration_ms / 1000
            while not release.is_set() and not context.cancellation.cancelled:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                with suppress(TimeoutError):
                    await asyncio.wait_for(release.wait(), min(remaining, 0.05))
            return None
        # The handler holds its slot until the probe stops or the worker cancels the attempt.
        while not release.is_set() and not context.cancellation.cancelled:
            with suppress(TimeoutError):
                await asyncio.wait_for(release.wait(), 0.05)
        return None

    psycopg_pool: AsyncConnectionPool[Any] | None = None
    asyncpg_pool: Any = None
    if variant == "async":
        psycopg_pool = AsyncConnectionPool(
            DATABASE_URL,
            min_size=0,
            max_size=POOL_SIZE,
            kwargs={"autocommit": True, "application_name": APPLICATION_NAME},
            open=False,
        )
        await psycopg_pool.open()
    else:
        asyncpg_pool = await asyncpg.create_pool(
            DATABASE_URL,
            min_size=0,
            max_size=POOL_SIZE,
            server_settings={"application_name": APPLICATION_NAME},
        )
    workers: list[AsyncWorker] = []
    for index in range(WORKERS):
        options: dict[str, Any] = {
            "queue": QUEUE,
            "worker_id": f"wh-bench-python-{variant}-{os.getpid()}-{index}",
            "concurrency": CONCURRENCY,
            "heartbeat_ms": HEARTBEAT_MS,
            "lease_ms": LEASE_MS,
            "poll_ms": POLL_MS,
        }
        try:
            worker = (
                AsyncWorker.from_psycopg(psycopg_pool, **options)
                if psycopg_pool is not None
                else AsyncWorker.from_asyncpg(asyncpg_pool, **options)
            )
        except Exception as error:
            emit({"event": "worker_error", "worker": index, "error": repr(error)})
            continue
        workers.append(worker.handle(TASK_TYPE, handler))

    def request_stop() -> None:
        arm_shutdown_deadline()
        # Stop claims first, then let the handlers return.
        for worker in workers:
            worker.stop()
        release.set()

    async def report_pool() -> None:
        # The pool state, seen from inside the process, every 250 ms until the probe stops.
        while not release.is_set():
            if psycopg_pool is not None:
                emit(psycopg_pool_state(psycopg_pool.get_stats()))
            else:
                emit(asyncpg_pool_state(asyncpg_pool))
            with suppress(TimeoutError):
                await asyncio.wait_for(release.wait(), 0.25)

    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, request_stop)
    emit(started(variant))
    reporter = asyncio.create_task(report_pool())
    results = await asyncio.gather(*(worker.run() for worker in workers), return_exceptions=True)
    await reporter
    for index, result in enumerate(results):
        if isinstance(result, BaseException):
            emit({"event": "worker_error", "worker": index, "error": repr(result)})
    if psycopg_pool is not None:
        await psycopg_pool.close()
    if asyncpg_pool is not None:
        await asyncpg_pool.close()
    emit({"event": "stopped"})


def main() -> None:
    variant = sys.argv[1] if len(sys.argv) > 1 else ""
    if variant == "sync":
        run_sync()
    elif variant in ("async", "asyncpg"):
        asyncio.run(run_async(variant))
    else:
        raise SystemExit("usage: connection_budget_probe.py sync|async|asyncpg")


if __name__ == "__main__":
    main()
