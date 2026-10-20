from workhorse import (
    ConcurrencyPolicyDefinition,
    EnqueueOptions,
    Queue,
    RateLimit,
    RateLimitPolicyDefinition,
)


def configure_flow_control(queue: Queue, message_id: str, tenant_id: str) -> None:
    queue.sync_concurrency_policies(
        "workers",
        (
            ConcurrencyPolicyDefinition(
                queue="mail", max_active=20, max_active_per_key=2
            ),
        ),
    )
    queue.sync_rate_limit_policies(
        "workers",
        (
            RateLimitPolicyDefinition(
                queue="provider-api",
                rate=RateLimit(limit=100, interval_ms=1_000, burst=200),
            ),
        ),
    )
    queue.enqueue(
        "mail.send",
        {"messageId": message_id},
        EnqueueOptions(queue="mail", concurrency_key=f"tenant:{tenant_id}"),
    )
