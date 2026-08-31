# `stablemates-workhorse`

The Python clients, worker runtimes, and dashboard host for the Workhorse PostgreSQL durable
execution protocol.

> **Public beta:** Workhorse is usable for evaluation and early production adoption, but 0.x minor
> releases may break compatibility, including the schema. There is no upgrade path between 0.x
> releases; ordered migrations begin at 1.0.0.

## Install

```bash
pip install stablemates-workhorse
```

Install the schema during deployment with the TypeScript CLI. Runtime processes should verify
compatibility instead of attempting schema changes.

Requires Python 3.12 through 3.14 and PostgreSQL 15 through 18.

## Run one job

```python
from __future__ import annotations

import os

import psycopg

from workhorse import Queue, Worker

database_url = os.environ["DATABASE_URL"]

with psycopg.connect(database_url) as application_connection:
    job_id = Queue(application_connection).enqueue("email.welcome", {"to": "ada@example.com"})
    application_connection.commit()

with psycopg.connect(database_url, autocommit=True) as worker_connection:
    worker = Worker(worker_connection).handle(
        "email.welcome",
        lambda payload, _context: {"deliveredTo": payload["to"]},
    )
    assert worker.run_once() is True  # Production worker processes call run().

print(job_id)
```

Handlers receive at-least-once delivery. Use stable provider idempotency keys around external
effects; named checkpoints prevent completed application stages from running after a later restart.

## Package boundary

This distribution provides synchronous Psycopg and asynchronous Psycopg or asyncpg clients and
workers. Application clients use caller-owned connections and transactions. Workers use dedicated
connections for claims and lifecycle calls. The package never installs or migrates the shared
PostgreSQL schema.

## Next

- Follow the [quickstart](https://workhorse.run/docs/quickstart) and deploy
  [worker processes](https://workhorse.run/docs/worker-processes).
- Read the [API reference](https://workhorse.run/docs/api) and
  [compatibility policy](https://workhorse.run/docs/compatibility).
- Use the [operations guide](https://workhorse.run/docs/operations) for telemetry, health, and
  maintenance.
- Browse the [repository](https://github.com/stablemates/workhorse) or report a problem in
  [GitHub issues](https://github.com/stablemates/workhorse/issues).

## License

Apache-2.0. See `LICENSE` and `NOTICE` in the package.
