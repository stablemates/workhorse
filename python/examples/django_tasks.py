"""Keeps a decorated Django task while WorkhorseTaskBackend accepts it atomically and a dedicated
Workhorse worker runs it.

Documentation: https://workhorse.run/docs/django-tasks
"""

from __future__ import annotations

import argparse
from typing import Any

import django
from django.tasks import task, task_backends
from psycopg_pool import ConnectionPool

from workhorse import Worker
from workhorse.django import WorkhorseTaskBackend


@task
def greet(name: str, *, punctuation: str = "!") -> dict[str, str]:
    return {"greeting": f"Hello, {name}{punctuation}"}


def main() -> None:
    parser = argparse.ArgumentParser(description="Dedicated Workhorse Django Tasks worker")
    parser.add_argument("--backend", default="default")
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--once", action="store_true")
    arguments = parser.parse_args()
    django.setup()
    backend: Any = task_backends[arguments.backend]
    if not isinstance(backend, WorkhorseTaskBackend):
        raise TypeError("Select a WorkhorseTaskBackend")
    with ConnectionPool(
        arguments.database_url, min_size=3, max_size=3, kwargs={"autocommit": True}
    ) as pool:
        worker = Worker(pool, queues=sorted(backend.queues))
        backend.bind_worker(worker)
        if arguments.once:
            worker.run_once()
        else:
            worker.run()


if __name__ == "__main__":
    main()
