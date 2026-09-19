from __future__ import annotations

import sys

from psycopg_pool import ConnectionPool

from workhorse import Worker

database_url, exit_code = sys.argv[1:]


def exit_process(_payload: object, _context: object) -> None:
    sys.exit(int(exit_code))


with ConnectionPool(database_url, min_size=3, max_size=3) as pool:
    Worker(
        pool,
        worker_id="python-exiting-worker",
        lease_ms=200,
        heartbeat_ms=50,
    ).handle("process.system-exit", exit_process).run()
