from __future__ import annotations

import sys
from time import sleep
from uuid import uuid4

import psycopg

from workhorse import ChildJobRequest, EnqueueOptions, HandlerContext, Json, Queue, Worker


def run(database_url: str) -> None:
    suffix = uuid4().hex
    parent_queue = f"python-example-parent-{suffix}"
    child_queue = f"python-example-child-{suffix}"
    job_type = f"order.process-{suffix}"
    child_type = f"order.step-{suffix}"

    with psycopg.connect(database_url) as enqueue_connection, enqueue_connection.transaction():
        queue = Queue(enqueue_connection, default_queue=parent_queue)
        job_id = queue.enqueue(
            job_type,
            {"orderId": "order-42"},
            EnqueueOptions(
                max_attempts=2,
                retry_policy={"type": "fixed", "delayMs": 0},
            ),
        )

    def process_order(payload: object, context: HandlerContext) -> dict[str, Json]:
        assert isinstance(payload, dict)
        prepared = context.checkpoint(
            "prepare",
            lambda: {"orderId": payload["orderId"], "prepared": True},
        )
        if context.job.attempt == 1:
            raise RuntimeError("demonstrate a PostgreSQL-owned retry")
        context.sleep("provider-backoff", 20)
        children = context.run_children_all(
            (
                ChildJobRequest(
                    "invoice",
                    child_type,
                    {"step": "invoice"},
                    EnqueueOptions(queue=child_queue),
                ),
                ChildJobRequest(
                    "receipt",
                    child_type,
                    {"step": "receipt"},
                    EnqueueOptions(queue=child_queue),
                ),
            )
        )
        approval = context.wait_for_signal("approval")
        decision = context.wait_for_human(
            "review",
            {"orderId": payload["orderId"], "approval": approval},
        )
        return {
            "prepared": prepared,
            "children": children,
            "approval": approval,
            "decision": decision,
        }

    with (
        psycopg.connect(database_url, autocommit=True) as parent_connection,
        psycopg.connect(database_url, autocommit=True) as child_connection,
    ):
        parent_worker = Worker(
            parent_connection,
            queue=parent_queue,
            worker_id=f"python-example-parent-{suffix}",
        ).handle(job_type, process_order)
        child_worker = Worker(
            child_connection,
            queue=child_queue,
            worker_id=f"python-example-child-{suffix}",
            concurrency=2,
        ).handle(
            child_type,
            lambda payload, _context: {"completed": payload["step"]},
        )

        assert parent_worker.run_once() is True
        sleep(0.03)
        assert parent_worker.run_once() is True
        assert child_worker.run_once() is True
        assert parent_worker.run_once() is True

        with psycopg.connect(database_url) as delivery_connection:
            delivery = Queue(delivery_connection)
            signal = delivery.send_signal(
                job_id,
                "approval",
                {"approved": True},
                idempotency_key=f"approval-{suffix}",
                requested_by="python-example",
            )
            delivery_connection.commit()
            assert signal.status == "delivered"

            assert parent_worker.run_once() is True
            decision = delivery.complete_human_wait(
                job_id,
                "review",
                {"approved": True, "reviewer": "operator-42"},
                idempotency_key=f"review-{suffix}",
                requested_by="operator-42",
            )
            delivery_connection.commit()
            assert decision.status == "completed"

        assert parent_worker.run_once() is True
        outcome = parent_connection.execute(
            "SELECT state, current_attempt, result FROM workhorse.job_outcome WHERE job_id = %s",
            (job_id,),
        ).fetchone()
        assert outcome is not None
        assert outcome[0:2] == ("succeeded", 2)
        assert outcome[2]["approval"] == {"approved": True}
        assert outcome[2]["children"] == {
            "invoice": {"completed": "invoice"},
            "receipt": {"completed": "receipt"},
        }


if __name__ == "__main__":
    run(sys.argv[1])
    print("Python lifecycle example completed")
