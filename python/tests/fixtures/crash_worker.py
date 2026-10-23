from __future__ import annotations

import sys
from pathlib import Path
from threading import Event

from psycopg_pool import ConnectionPool

from workhorse import Worker

database_url, started_path = sys.argv[1:]


def block_forever(_payload: object, _context: object) -> None:
    Path(started_path).touch()
    Event().wait()


with ConnectionPool(database_url, min_size=3, max_size=3, kwargs={"autocommit": True}) as pool:
    Worker(
        pool,
        worker_id="python-crash-worker",
        # The test waits for this lease to lapse. 100 ms is the smallest supported interval, and
        # 2 * 100 ms + a 75 ms round bound is less than the lease.
        lease_ms=400,
        heartbeat_ms=100,
    ).handle("process.crash-recovery", block_forever).run()
