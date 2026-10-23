from __future__ import annotations

import sys

from psycopg_pool import ConnectionPool

from workhorse import Worker

database_url, exit_code = sys.argv[1:]


def exit_process(_payload: object, _context: object) -> None:
    sys.exit(int(exit_code))


with ConnectionPool(database_url, min_size=3, max_size=3, kwargs={"autocommit": True}) as pool:
    Worker(
        pool,
        worker_id="python-exiting-worker",
        # The test waits for this lease to lapse. 100 ms is the smallest supported interval, and
        # 2 * 100 ms + a 75 ms round bound is less than the lease.
        lease_ms=400,
        heartbeat_ms=100,
    ).handle("process.system-exit", exit_process).run()
