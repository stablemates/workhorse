from __future__ import annotations

import os
import socket
from collections.abc import Mapping
from typing import Any
from uuid import uuid4

import psycopg

from workhorse import HandlerContext, Json, Worker, run_worker_process

LANGUAGE_JOB_TYPE = "demo.language-worker"
SHARED_JOB_TYPE = "demo.shared-worker"
PYTHON_QUEUE = "demo-python"
SHARED_QUEUE = "demo-shared"
SCHEDULE_NAMESPACE = "workhorse-demo"
WORKER_CONCURRENCY = 3
DEFAULT_POLL_MS = 15_000


def database_url(environment: Mapping[str, str] = os.environ) -> str:
    value = environment.get("DATABASE_URL_PRIMARY")
    if not value:
        raise RuntimeError("DATABASE_URL_PRIMARY is required")
    return value


def language_job(payload: Any, context: HandlerContext) -> dict[str, Json]:
    if not isinstance(payload, dict) or payload.get("language") != "python":
        raise ValueError("Python worker received a job for another language")
    return {"language": "python", "runtime": "python", "attempt": context.job.attempt}


def shared_job(payload: Any, context: HandlerContext) -> dict[str, Json]:
    if not isinstance(payload, dict) or not isinstance(payload.get("source"), str):
        raise ValueError("Shared worker requires a source")
    return {"source": payload["source"], "runtime": "python", "attempt": context.job.attempt}


def worker_id() -> str:
    hostname = "".join(
        character if character.isalnum() or character in ".-_" else "-"
        for character in socket.gethostname()
    )
    return f"demo-python-{hostname or 'unknown-host'}-{os.getpid()}-{str(uuid4())[:8]}"


def main() -> None:
    poll_ms = int(os.environ.get("WORKHORSE_WORKER_POLL_MS", DEFAULT_POLL_MS))
    with psycopg.connect(database_url(), autocommit=True) as connection:
        worker = (
            Worker(
                connection,
                queues=(PYTHON_QUEUE, SHARED_QUEUE),
                worker_id=worker_id(),
                concurrency=WORKER_CONCURRENCY,
                poll_ms=poll_ms,
                schedule_namespaces=(SCHEDULE_NAMESPACE,),
                maintenance_interval_ms=1_000,
                registry_interval_ms=250,
            )
            .handle(LANGUAGE_JOB_TYPE, language_job)
            .handle(SHARED_JOB_TYPE, shared_job)
        )
        run_worker_process(worker)


if __name__ == "__main__":
    main()
