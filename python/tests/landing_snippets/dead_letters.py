from workhorse import Admin, AdminAudit, DeadLetterQuery


def redrive_billing(admin: Admin) -> None:
    page = admin.list_dead_letters(
        DeadLetterQuery(
            queue="billing",
            error_name="CardDeclined",
        )
    )
    for failure in page.items:
        admin.redrive(
            failure.task_id,
            AdminAudit(
                actor="operator@example.com",
                reason="provider incident resolved",
                request_id=f"incident-2026-08-03:{failure.task_id}",
            ),
        )
