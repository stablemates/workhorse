from __future__ import annotations

import sys

import psycopg

from workhorse import Worker

database_url, exit_code = sys.argv[1:]


def exit_process(_payload: object, _context: object) -> None:
    sys.exit(int(exit_code))


with psycopg.connect(database_url, autocommit=True) as connection:
    Worker(
        connection,
        worker_id="python-exiting-worker",
        lease_ms=200,
        heartbeat_ms=50,
    ).handle("process.system-exit", exit_process).run()
