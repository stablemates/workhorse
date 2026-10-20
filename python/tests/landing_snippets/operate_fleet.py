import psycopg

from workhorse import Admin, AdminAudit


def pause_billing(database_url: str) -> None:
    with psycopg.connect(database_url) as connection:
        admin = Admin(connection)
        for entry in admin.list_workers():
            if entry.queue != "billing":
                continue
            admin.set_worker_paused(
                entry.worker_id,
                True,
                AdminAudit(
                    actor="operator@example.com",
                    reason="rolling deploy",
                    request_id=f"deploy-2026-08-23:{entry.worker_id}",
                ),
            )
