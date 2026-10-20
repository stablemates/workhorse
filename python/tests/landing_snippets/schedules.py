import psycopg
from psycopg_pool import ConnectionPool

from workhorse import (
    HandlerContext,
    Json,
    Queue,
    ScheduleDefinition,
    ScheduledTask,
    Worker,
)


def run_billing(database_url: str) -> None:
    with psycopg.connect(database_url) as connection:
        Queue(connection).sync_schedules(
            "billing",
            (
                ScheduleDefinition(
                    name="nightly-invoice-run",
                    schedule="0 2 * * *",
                    task=ScheduledTask(type="invoices.generate", payload={}),
                ),
            ),
        )

    def generate(_payload: object, _context: HandlerContext) -> dict[str, Json]:
        return {"generated": True}

    with ConnectionPool(
        database_url, min_size=3, max_size=3, kwargs={"autocommit": True}
    ) as pool:
        Worker(
            pool,
            schedule_namespaces=("billing",),
        ).handle("invoices.generate", generate).run()
