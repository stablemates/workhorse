from datetime import datetime

from workhorse import EnqueueOptions, Queue


def enqueue_reminder(queue: Queue, match_id: str, kickoff: datetime) -> str:
    return queue.enqueue(
        "match.reminder",
        {"matchId": match_id},
        EnqueueOptions(
            deadline=kickoff,
            execution_timeout_ms=30_000,
            max_attempts=5,
            retry_policy={
                "type": "exponential",
                "initialDelayMs": 1_000,
                "multiplier": 2,
                "maxDelayMs": 60_000,
            },
        ),
    )
