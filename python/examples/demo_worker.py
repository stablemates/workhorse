from __future__ import annotations

import os
import socket
from collections.abc import Mapping
from typing import Any
from uuid import uuid4

from psycopg_pool import ConnectionPool

from workhorse import HandlerContext, Json, Worker, run_worker_process

LANGUAGE_TASK_TYPE = "demo.language-worker"
SHARED_TASK_TYPE = "demo.shared-worker"
PYTHON_QUEUE = "demo-python"
PYTHON_FAST_QUEUE = "demo-python-fast"
SHARED_QUEUE = "demo-shared"
SCHEDULE_NAMESPACE = "workhorse-demo"
FAST_TIER_SCHEDULE_NAMESPACE = "workhorse-demo-fast-tier"
WORKER_CONCURRENCY = 3
DEFAULT_POLL_MS = 15_000


def database_url(environment: Mapping[str, str] = os.environ) -> str:
    value = environment.get("DATABASE_URL_PRIMARY")
    if not value:
        raise RuntimeError("DATABASE_URL_PRIMARY is required")
    return value


def language_task(payload: Any, context: HandlerContext) -> dict[str, Json]:
    if not isinstance(payload, dict) or payload.get("language") != "python":
        raise ValueError("Python worker received a task for another language")
    return {"language": "python", "runtime": "python", "attempt": context.task.attempt}


def shared_task(payload: Any, context: HandlerContext) -> dict[str, Json]:
    if not isinstance(payload, dict) or not isinstance(payload.get("source"), str):
        raise ValueError("Shared worker requires a source")
    return {"source": payload["source"], "runtime": "python", "attempt": context.task.attempt}


def worker_id() -> str:
    hostname = "".join(
        character if character.isalnum() or character in ".-_" else "-"
        for character in socket.gethostname()
    )
    return f"demo-python-{hostname or 'unknown-host'}-{os.getpid()}-{str(uuid4())[:8]}"


def build_worker(pool: ConnectionPool, poll_ms: int) -> Worker:
    return (
        Worker(
            pool,
            queues=(PYTHON_QUEUE, SHARED_QUEUE, PYTHON_FAST_QUEUE),
            worker_id=worker_id(),
            concurrency=WORKER_CONCURRENCY,
            poll_ms=poll_ms,
            schedule_namespaces=(SCHEDULE_NAMESPACE, FAST_TIER_SCHEDULE_NAMESPACE),
            maintenance_interval_ms=1_000,
            registry_interval_ms=250,
        )
        .handle(LANGUAGE_TASK_TYPE, language_task)
        .handle(SHARED_TASK_TYPE, shared_task)
    )


def main() -> None:
    poll_ms = int(os.environ.get("WORKHORSE_WORKER_POLL_MS", DEFAULT_POLL_MS))
    with ConnectionPool(
        database_url(),
        min_size=WORKER_CONCURRENCY + 3,
        max_size=WORKER_CONCURRENCY + 3,
        kwargs={"autocommit": True},
    ) as pool:
        run_worker_process(build_worker(pool, poll_ms))


if __name__ == "__main__":
    main()
