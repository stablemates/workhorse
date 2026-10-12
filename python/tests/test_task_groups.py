from __future__ import annotations
# ruff: noqa

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import asyncpg
import psycopg
import pytest

from workhorse import (
    MAX_TASK_GROUP_MEMBERS,
    Admin,
    AdminAudit,
    AsyncAdmin,
    AsyncHandlerContext,
    AsyncQueue,
    AsyncWorker,
    Debounce,
    EnqueueOptions,
    EnqueueRequest,
    FastTierUnsupportedError,
    HandlerContext,
    Idempotency,
    Queue,
    TaskContractVersion,
    TaskGroupClosedError,
    TaskGroupLimitExceededError,
    TaskGroupLink,
    TaskGroupMembershipConflictError,
    TaskTypeContracts,
    Worker,
)
from workhorse.errors import _translate_database_error

worker_pool: Any

WORKER = "python-group-worker"


def member(queue: str, payload: int, **options: Any) -> EnqueueRequest:
    return EnqueueRequest(
        "member",
        payload,
        EnqueueOptions(queue=queue, max_attempts=options.pop("max_attempts", 1), **options),
    )


def callbacks(queue: str) -> dict[str, EnqueueRequest]:
    return {
        "on_finish": EnqueueRequest("finished", {"kind": "finish"}, EnqueueOptions(queue=queue)),
        "on_success": EnqueueRequest("succeeded", {"kind": "success"}, EnqueueOptions(queue=queue)),
        "on_failure": EnqueueRequest("failed", {"kind": "failure"}, EnqueueOptions(queue=queue)),
    }


def audit(reason: str) -> AdminAudit:
    return AdminAudit("python-test", reason, str(uuid4()))


@contextmanager
def clients(database_url: str) -> Iterator[tuple[psycopg.Connection[Any], Queue, Admin]]:
    with psycopg.connect(database_url, autocommit=True) as connection:
        yield connection, Queue(connection), Admin(connection)


def claim(
    connection: psycopg.Connection[Any], queue: str, limit: int = 100
) -> list[tuple[str, int]]:
    rows = connection.execute(
        "SELECT task_id, fence_token FROM workhorse.claim_many_v1(%s, %s, %s, 30000)",
        (queue, WORKER, limit),
    ).fetchall()
    return [(str(task_id), int(fence)) for task_id, fence in rows]


def complete_all(connection: psycopg.Connection[Any], queue: str) -> None:
    for task_id, fence in claim(connection, queue):
        row = connection.execute(
            "SELECT workhorse.complete_v1(%s, %s, %s, 'null'::jsonb)", (task_id, WORKER, fence)
        ).fetchone()
        assert row == (True,)


def fail(connection: psycopg.Connection[Any], task_id: str, fence: int) -> str:
    row = connection.execute(
        "SELECT workhorse.fail_v1(%s, %s, %s, %s::jsonb, 0)",
        (task_id, WORKER, fence, '{"name":"Error","message":"boom"}'),
    ).fetchone()
    assert row is not None
    return str(row[0])


def task_types(connection: psycopg.Connection[Any], queue: str) -> list[str]:
    rows = connection.execute(
        "SELECT task_type FROM workhorse.task WHERE queue_name = %s ORDER BY task_type", (queue,)
    ).fetchall()
    return [row[0] for row in rows]


def test_block_form_creates_adds_and_seals_then_enqueues_on_finish_and_on_success(
    database_url: str,
) -> None:
    with clients(database_url) as (connection, queue, admin):
        with queue.task_group(**callbacks("block-callbacks")) as builder:
            builder.add([member("block-members", 1), member("block-members", 2)])
            builder.add([member("block-members", 3)])
        group = builder.result.group
        assert group.state == "sealed"
        assert group.result is None
        assert (group.counts.total, group.counts.pending) == (3, 3)
        assert [task.outcome for task in builder.result.tasks] == ["accepted"] * 3

        complete_all(connection, "block-members")
        finished = queue.get_task_group(group.id)
        assert finished is not None
        assert (finished.state, finished.result) == ("finished", "succeeded")
        assert (finished.counts.succeeded, finished.counts.pending) == (3, 0)
        by_kind = {callback.kind: callback.task_id for callback in finished.callbacks}
        assert sorted(by_kind) == ["on_failure", "on_finish", "on_success"]
        assert by_kind["on_failure"] is None
        assert by_kind["on_finish"] is not None
        assert task_types(connection, "block-callbacks") == ["finished", "succeeded"]
        assert [event.type for event in admin.list_task_group_events(group.id)] == [
            "created",
            "sealed",
            "finished",
            "callback_enqueued",
            "callback_enqueued",
        ]

        page = queue.list_task_group_members(group.id, limit=2)
        assert [(item.position, item.outcome, item.state) for item in page.members] == [
            (1, "succeeded", "succeeded"),
            (2, "succeeded", "succeeded"),
        ]
        assert page.next_after == 2
        rest = admin.list_task_group_members(group.id, after=2)
        assert [item.position for item in rest.members] == [3]
        assert rest.next_after is None
        assert admin.get_task_group(group.id) == finished


def test_block_form_creates_nothing_when_the_block_raises(database_url: str) -> None:
    with clients(database_url) as (connection, queue, _admin):
        with pytest.raises(RuntimeError, match="stop"):
            with queue.task_group() as builder:
                builder.add([member("raised-members", 1)])
                raise RuntimeError("stop")
        with pytest.raises(RuntimeError, match="has not created"):
            builder.result
        assert connection.execute("SELECT count(*) FROM workhorse.task_group").fetchone() == (0,)


def test_a_callback_handler_reads_the_group_through_the_context(database_url: str) -> None:
    with clients(database_url) as (connection, queue, _admin):
        report = EnqueueRequest("report", {"report": True}, EnqueueOptions(queue="ctx-cb"))
        with queue.task_group(on_finish=report) as builder:
            builder.add([member("ctx-members", 1)])
        group = builder.result.group
        [(task_id, fence)] = claim(connection, "ctx-members")
        assert fail(connection, task_id, fence) == "failed"

    seen: list[TaskGroupLink | None] = []
    payloads: list[object] = []

    def handle(payload: object, context: HandlerContext) -> None:
        payloads.append(payload)
        seen.append(context.task_group.get())
        seen.append(context.task_group.get())
        return None

    worker = Worker(worker_pool, queue="ctx-cb", worker_id="ctx-worker").handle("report", handle)
    assert worker.run_once() is True
    assert payloads == [{"report": True}]
    link = seen[0]
    assert link is not None and seen[1] is link
    assert (link.role, link.callback) == ("callback", "on_finish")
    assert link.group.id == group.id
    assert (link.group.result, link.group.counts.total, link.group.counts.failed) == (
        "failed",
        1,
        1,
    )


def test_on_failure_runs_when_a_member_fails_and_a_canceled_member_does_not_succeed(
    database_url: str,
) -> None:
    with clients(database_url) as (connection, queue, _admin):
        with queue.task_group(**callbacks("fail-callbacks")) as builder:
            builder.add([member("fail-members", 1), member("fail-members", 2)])
        group = builder.result.group
        (first, first_fence), (second, second_fence) = claim(connection, "fail-members")
        assert fail(connection, first, first_fence) == "failed"
        queue.cancel(second, requested_by="test", reason="stop")
        assert connection.execute(
            "SELECT workhorse.acknowledge_cancel_v1(%s, %s, %s)", (second, WORKER, second_fence)
        ).fetchone() == (True,)
        finished = queue.get_task_group(group.id)
        assert finished is not None
        assert (finished.state, finished.result) == ("finished", "failed")
        assert (finished.counts.failed, finished.counts.canceled) == (1, 1)
        assert task_types(connection, "fail-callbacks") == ["failed", "finished"]


def test_an_empty_group_finishes_at_the_seal_and_refuses_an_add(database_url: str) -> None:
    with clients(database_url) as (connection, queue, _admin):
        group = queue.create_task_group(**callbacks("empty-callbacks"))
        assert (group.state, group.counts.total) == ("open", 0)
        sealed = queue.seal_task_group(group.id)
        assert (sealed.state, sealed.result) == ("finished", "succeeded")
        assert task_types(connection, "empty-callbacks") == ["finished", "succeeded"]
        with pytest.raises(TaskGroupClosedError) as refusal:
            queue.add_to_task_group(group.id, [member("empty-members", 1)])
        assert (refusal.value.group_id, refusal.value.state, refusal.value.reason) == (
            group.id,
            "finished",
            "finished",
        )
        assert queue.seal_task_group(group.id).state == "finished"


def test_after_the_seal_only_a_running_member_adds_tasks(database_url: str) -> None:
    with clients(database_url) as (connection, queue, _admin):
        with queue.task_group(**callbacks("member-add-cb")) as builder:
            builder.add([member("member-add", 1)])
        group = builder.result.group
        with pytest.raises(TaskGroupClosedError) as refusal:
            queue.add_to_task_group(group.id, [member("member-add", 2)])
        assert refusal.value.reason == "sealed"

        def handle(payload: int, context: HandlerContext) -> None:
            if payload == 1:
                [added] = context.task_group.add([member("member-add", 10)])
                assert added.outcome == "accepted"
            return None

        worker = Worker(worker_pool, queue="member-add", worker_id="member-add-worker").handle(
            "member", handle
        )
        # The worker claims the added member in the same pass, so the group finishes.
        assert worker.run_once() is True
        current = queue.get_task_group(group.id)
        assert current is not None
        assert (current.state, current.counts.total, current.counts.succeeded) == ("finished", 2, 2)

        # A stale member lease cannot add.
        with queue.task_group() as other:
            other.add([member("stale-add", 1)])
        [(task_id, fence)] = claim(connection, "stale-add")
        with pytest.raises(TaskGroupClosedError) as stale:
            queue._add_to_task_group(
                other.result.group.id, [member("stale-add", 2)], (task_id, WORKER, fence + 1)
            )
        assert (stale.value.group_id, stale.value.reason) == (
            other.result.group.id,
            "not_running_member",
        )


def test_a_task_without_a_group_cannot_add_through_its_context(database_url: str) -> None:
    with clients(database_url) as (_connection, queue, _admin):
        queue.enqueue("lonely", {}, EnqueueOptions(queue="lonely", max_attempts=1))
    errors: list[BaseException] = []

    def handle(_payload: object, context: HandlerContext) -> None:
        assert context.task_group.get() is None
        try:
            context.task_group.add([member("lonely", 2)])
        except TypeError as error:
            errors.append(error)
        return None

    worker = Worker(worker_pool, queue="lonely", worker_id="lonely-worker").handle("lonely", handle)
    assert worker.run_once() is True
    assert len(errors) == 1
    assert "is not a member of a task group" in str(errors[0])


def test_membership_rules(database_url: str) -> None:
    with clients(database_url) as (_connection, queue, admin):
        group = queue.create_task_group()
        admin.set_queue_tier("fast-members", "fast", audit("fast tier"))
        with pytest.raises(FastTierUnsupportedError) as fast:
            queue.add_to_task_group(group.id, [member("fast-members", 1)])
        assert fast.value.feature == "task groups"

        with pytest.raises(ValueError, match="cannot use debounce or throttle"):
            queue.add_to_task_group(
                group.id,
                [member("rules", 1, debounce=Debounce("k", window_ms=1_000, schedule="reset"))],
            )

        # A task enqueued outside the group cannot join it through an idempotency hit.
        [outside] = queue.enqueue_many([member("rules", 1, idempotency=Idempotency("outside"))])
        with pytest.raises(TaskGroupMembershipConflictError) as conflict:
            queue.add_to_task_group(
                group.id, [member("rules", 1, idempotency=Idempotency("outside"))]
            )
        assert (
            conflict.value.group_id,
            conflict.value.task_id,
            conflict.value.ordinal,
            conflict.value.member_of,
        ) == (group.id, outside, 1, None)

        # An idempotent retry of the same add returns the existing member.
        [added] = queue.add_to_task_group(
            group.id, [member("rules", 2, idempotency=Idempotency("inside"))]
        )
        [replayed] = queue.add_to_task_group(
            group.id, [member("rules", 2, idempotency=Idempotency("inside"))]
        )
        assert (replayed.task_id, replayed.outcome) == (added.task_id, "replayed")
        current = queue.get_task_group(group.id)
        assert current is not None and current.counts.total == 1

        # The same task cannot join a second group.
        other = queue.create_task_group()
        with pytest.raises(TaskGroupMembershipConflictError) as second:
            queue.add_to_task_group(
                other.id, [member("rules", 2, idempotency=Idempotency("inside"))]
            )
        assert second.value.member_of == group.id

        with pytest.raises(ValueError, match="at most 1000 tasks"):
            queue.add_to_task_group(group.id, [member("rules", index) for index in range(1_001)])
        assert queue.add_to_task_group(group.id, []) == []


def test_a_redriven_member_is_not_a_member(database_url: str) -> None:
    with clients(database_url) as (connection, queue, admin):
        with queue.task_group() as builder:
            builder.add([member("redrive-members", 1)])
        [(task_id, fence)] = claim(connection, "redrive-members")
        assert fail(connection, task_id, fence) == "failed"
        redrive = admin.redrive(task_id, audit("redrive"))
        assert redrive.target_task_id is not None
        assert queue.find_task_group(redrive.target_task_id) is None
        link = queue.find_task_group(task_id)
        assert link is not None
        assert (link.role, link.group.id) == ("member", builder.result.group.id)


def test_callbacks_reject_coalescing_and_can_run_on_a_fast_tier_queue(database_url: str) -> None:
    with clients(database_url) as (connection, queue, admin):
        coalesced = EnqueueRequest("cb", None, EnqueueOptions(idempotency=Idempotency("k")))
        with pytest.raises(ValueError, match="idempotency, debounce, or throttle"):
            queue.create_task_group(on_finish=coalesced)
        with pytest.raises(ValueError, match="idempotency, debounce, or throttle"):
            with queue.task_group(on_failure=coalesced):
                raise AssertionError("the block must not run")
        assert connection.execute("SELECT count(*) FROM workhorse.task_group").fetchone() == (0,)

        admin.set_queue_tier("fast-callbacks", "fast", audit("fast tier"))
        callback = EnqueueRequest("cb", None, EnqueueOptions(queue="fast-callbacks"))
        with queue.task_group(on_finish=callback) as builder:
            builder.add([member("fast-cb-members", 1)])
        complete_all(connection, "fast-cb-members")
        group = queue.get_task_group(builder.result.group.id)
        assert group is not None
        [stored] = group.callbacks
        assert stored.task_id is not None
        link = queue.find_task_group(stored.task_id)
        assert link is not None
        assert (link.role, link.callback) == ("callback", "on_finish")


def test_a_callback_carries_the_current_contract_version_after_a_mismatch(
    database_url: str,
) -> None:
    with clients(database_url) as (connection, queue, _admin):
        versions = {"one": TaskContractVersion(), "two": TaskContractVersion()}
        queue.sync_contracts({"contracted.callback": TaskTypeContracts("one", versions)})
        connection.execute(
            "SELECT workhorse.override_contract_version_v1('contracted.callback', 'two')"
        )
        group = queue.create_task_group(
            on_finish=EnqueueRequest("contracted.callback", {}, EnqueueOptions(queue="contract-cb"))
        )
        assert connection.execute(
            "SELECT on_finish->>'contractVersion', on_finish ? 'runAt' FROM workhorse.task_group "
            "WHERE id = %s",
            (group.id,),
        ).fetchone() == ("two", False)
        assert connection.execute("SELECT count(*) FROM workhorse.task_group").fetchone() == (1,)


def test_cancel_seals_cancels_live_members_and_finishes_through_on_failure(
    database_url: str,
) -> None:
    with clients(database_url) as (connection, queue, admin):
        group = queue.create_task_group(**callbacks("cancel-cb"))
        queue.add_to_task_group(
            group.id,
            [member("cancel-members", 1), member("cancel-members", 2), member("cancel-members", 3)],
        )
        [(running, fence)] = claim(connection, "cancel-members", 1)
        stop = audit("stop the import")
        canceled = admin.cancel_task_group(group.id, stop)
        assert canceled is not None
        assert canceled.state == "sealed"
        assert (canceled.canceled_by, canceled.cancel_reason) == (stop.actor, stop.reason)
        assert (canceled.counts.canceled, canceled.counts.pending) == (2, 1)
        with pytest.raises(TaskGroupClosedError) as refusal:
            queue._add_to_task_group(
                group.id, [member("cancel-members", 4)], (running, WORKER, fence)
            )
        assert refusal.value.reason == "canceled"
        assert connection.execute(
            "SELECT workhorse.acknowledge_cancel_v1(%s, %s, %s)", (running, WORKER, fence)
        ).fetchone() == (True,)
        finished = queue.get_task_group(group.id)
        assert finished is not None
        assert (finished.state, finished.result, finished.counts.canceled) == (
            "finished",
            "failed",
            3,
        )
        assert task_types(connection, "cancel-cb") == ["failed", "finished"]
        assert [event.type for event in admin.list_task_group_events(group.id)] == [
            "created",
            "sealed",
            "canceled",
            "finished",
            "callback_enqueued",
            "callback_enqueued",
        ]
        assert admin.cancel_task_group(group.id, audit("again")) == finished
        assert admin.cancel_task_group(str(uuid4()), audit("unknown")) is None


def test_a_purged_member_counts_as_canceled(database_url: str) -> None:
    with clients(database_url) as (connection, queue, admin):
        with queue.task_group(**callbacks("purge-members")) as builder:
            builder.add([member("purge-members", 1), member("purge-other", 2)])
        group_id = builder.result.group.id
        complete_all(connection, "purge-other")
        assert admin.purge_queue("purge-members", audit("purge")) == 1
        group = queue.get_task_group(group_id)
        assert group is not None
        assert (group.state, group.result, group.counts.succeeded, group.counts.canceled) == (
            "finished",
            "failed",
            1,
            1,
        )
        assert task_types(connection, "purge-members") == ["failed", "finished"]
        members = admin.list_task_group_members(group_id).members
        assert [(item.position, item.outcome, item.state, item.queue) for item in members] == [
            (1, "canceled", None, None),
            (2, "succeeded", "succeeded", "purge-other"),
        ]


def test_drift_is_listed_and_repaired(database_url: str) -> None:
    with clients(database_url) as (connection, queue, admin):
        with queue.task_group(**callbacks("drift-cb")) as builder:
            builder.add([member("drift-members", 1), member("drift-members", 2)])
        group_id = builder.result.group.id
        complete_all(connection, "drift-members")
        # Simulate a lost count: the members are finished, but the group counts them pending.
        connection.execute(
            "UPDATE workhorse.task_group_member SET outcome = NULL, counted_at = NULL "
            "WHERE group_id = %s",
            (group_id,),
        )
        # The counts of a group that is not finished live in its shard rows (ADR 0096). The two
        # members are in shards 0 and 1, so two shards are pending.
        connection.execute(
            "UPDATE workhorse.task_group_shard SET succeeded_count = 0 WHERE group_id = %s",
            (group_id,),
        )
        connection.execute(
            "UPDATE workhorse.task_group SET state = 'sealed', result = NULL, finished_at = NULL, "
            "total_count = 0, succeeded_count = 0, pending_shard_count = 2 WHERE id = %s",
            (group_id,),
        )
        connection.execute(
            "DELETE FROM workhorse.task_group_callback WHERE group_id = %s", (group_id,)
        )
        connection.execute("DELETE FROM workhorse.task WHERE queue_name = 'drift-cb'")

        [drift] = admin.list_task_group_drift()
        assert (drift.group_id, drift.state, drift.action) == (group_id, "sealed", "finished")
        assert (drift.recorded.total, drift.recorded.succeeded) == (2, 0)
        assert (drift.counted.succeeded, drift.counted.pending) == (2, 0)
        with pytest.raises(ValueError, match="limit must be an integer from 1 to 10000"):
            admin.list_task_group_drift(limit=10_001)

        repair = audit("repair the counter")
        [repaired] = admin.repair_task_group_drift(repair)
        assert (
            repaired.group_id,
            repaired.recorded_pending,
            repaired.pending,
            repaired.action,
        ) == (
            group_id,
            2,
            0,
            "finished",
        )
        group = queue.get_task_group(group_id)
        assert group is not None and (group.state, group.result) == ("finished", "succeeded")
        assert task_types(connection, "drift-cb") == ["finished", "succeeded"]
        [event] = [
            event
            for event in admin.list_task_group_events(group_id)
            if event.type == "counter_repaired"
        ]
        assert isinstance(event.details, dict)
        assert event.details["requested_by"] == repair.actor
        assert event.details["request_reason"] == repair.reason
        assert admin.list_task_group_drift() == ()


def test_the_member_limit_is_checked_under_the_group_lock(database_url: str) -> None:
    with clients(database_url) as (connection, queue, _admin):
        group = queue.create_task_group()
        queue.add_to_task_group(group.id, [member("limit-members", 1)])
        # The member count is the sum of the shard totals (ADR 0096). Member 1 is in shard 0.
        connection.execute(
            "UPDATE workhorse.task_group_shard SET total_count = total_count + %s "
            "WHERE group_id = %s AND shard = 1",
            (MAX_TASK_GROUP_MEMBERS - 2, group.id),
        )
        with pytest.raises(TaskGroupLimitExceededError) as refusal:
            queue.add_to_task_group(
                group.id, [member("limit-members", 2), member("limit-members", 3)]
            )
        assert (
            refusal.value.group_id,
            refusal.value.limit,
            refusal.value.total,
            refusal.value.requested,
        ) == (group.id, MAX_TASK_GROUP_MEMBERS, MAX_TASK_GROUP_MEMBERS - 1, 2)
        assert connection.execute(
            "SELECT count(*) FROM workhorse.task WHERE queue_name = 'limit-members'"
        ).fetchone() == (1,)


def test_a_member_whose_enqueue_writes_its_outcome_is_counted(database_url: str) -> None:
    with clients(database_url) as (_connection, queue, _admin):
        late = datetime.now(UTC) - timedelta(minutes=1)
        with queue.task_group() as builder:
            builder.add([member("late-members", 1, deadline=late)])
        group = queue.get_task_group(builder.result.group.id)
        assert group is not None
        assert (group.state, group.result, group.counts.failed) == ("finished", "failed", 1)


def test_reads_validate_their_pages(database_url: str) -> None:
    with clients(database_url) as (_connection, queue, admin):
        group_id = str(uuid4())
        assert queue.get_task_group(group_id) is None
        with pytest.raises(ValueError, match="from 1 to 1000"):
            queue.list_task_group_members(group_id, limit=1_001)
        with pytest.raises(ValueError, match="non-negative"):
            admin.list_task_group_members(group_id, after=-1)
        with pytest.raises(ValueError, match="from 1 to 1000"):
            admin.list_task_group_events(group_id, limit=0)


async def test_async_clients_and_worker_use_task_groups(database_url: str, asyncpg_pool) -> None:
    connection = await asyncpg.connect(database_url)
    try:
        queue = AsyncQueue.from_asyncpg(connection)
        admin = AsyncAdmin.from_asyncpg(connection)
        report = EnqueueRequest("report", {"report": True}, EnqueueOptions(queue="async-cb"))
        async with queue.task_group(on_success=report) as builder:
            builder.add([member("async-members", 1)])
        group = builder.result.group
        assert (group.state, group.counts.total) == ("sealed", 1)
        assert [callback.kind for callback in group.callbacks] == ["on_success"]

        seen: list[TaskGroupLink | None] = []

        async def handle_member(payload: int, context: AsyncHandlerContext) -> None:
            link = await context.task_group.get()
            seen.append(link)
            if payload == 1:
                await context.task_group.add([member("async-members", 2)])
            return None

        async def handle_report(_payload: object, context: AsyncHandlerContext) -> None:
            seen.append(await context.task_group.get())
            return None

        members = AsyncWorker.from_asyncpg(
            asyncpg_pool, queue="async-members", worker_id="async-member-worker"
        ).handle("member", handle_member)
        # The worker claims the added member in the same pass.
        assert await members.run_once() is True
        reports = AsyncWorker.from_asyncpg(
            asyncpg_pool, queue="async-cb", worker_id="async-report-worker"
        ).handle("report", handle_report)
        assert await reports.run_once() is True

        assert [link.role if link else None for link in seen] == ["member", "member", "callback"]
        finished = await queue.get_task_group(group.id)
        assert finished is not None
        assert (finished.state, finished.result, finished.counts.total) == (
            "finished",
            "succeeded",
            2,
        )
        page = await admin.list_task_group_members(group.id)
        assert [item.position for item in page.members] == [1, 2]
        events = await admin.list_task_group_events(group.id)
        assert events[0].type == "created"
        assert await admin.list_task_group_drift() == ()
        assert await admin.cancel_task_group(group.id, audit("done")) == finished

        empty = await queue.create_task_group()
        assert (await queue.seal_task_group(empty.id)).state == "finished"
        with pytest.raises(TaskGroupClosedError):
            await queue.add_to_task_group(empty.id, [member("async-members", 3)])
        link = await queue.find_task_group(page.members[0].task_id)
        assert link is not None and link.group.id == group.id
    finally:
        await connection.close()


async def test_async_psycopg_clients_and_worker_use_task_groups(
    database_url: str, async_psycopg_pool
) -> None:
    connection = await psycopg.AsyncConnection.connect(database_url, autocommit=True)
    try:
        queue = AsyncQueue.from_psycopg(connection)
        admin = AsyncAdmin.from_psycopg(connection)
        report = EnqueueRequest("report", {"report": True}, EnqueueOptions(queue="apg-cb"))
        async with queue.task_group(on_finish=report) as builder:
            builder.add([member("apg-members", 1)])
        group = builder.result.group
        assert (group.state, group.result, group.counts.total) == ("sealed", None, 1)

        seen: list[TaskGroupLink | None] = []

        async def handle(_payload: object, context: AsyncHandlerContext) -> None:
            seen.append(await context.task_group.get())
            return None

        for queue_name, task_type in (("apg-members", "member"), ("apg-cb", "report")):
            worker = AsyncWorker.from_psycopg(
                async_psycopg_pool, queue=queue_name, worker_id=f"{queue_name}-worker"
            ).handle(task_type, handle)
            assert await worker.run_once() is True

        assert [(link.role, link.callback) if link else None for link in seen] == [
            ("member", None),
            ("callback", "on_finish"),
        ]
        callback = seen[1]
        assert callback is not None
        assert (callback.group.result, callback.group.counts.succeeded) == ("succeeded", 1)
        finished = await queue.get_task_group(group.id)
        assert finished is not None and finished.result == "succeeded"
        assert await admin.get_task_group(group.id) == finished
        page = await queue.list_task_group_members(group.id)
        assert [(item.position, item.outcome) for item in page.members] == [(1, "succeeded")]
        assert [event.type for event in await admin.list_task_group_events(group.id)][-1] == (
            "callback_enqueued"
        )
        assert await admin.repair_task_group_drift(audit("nothing to repair")) == ()
    finally:
        await connection.close()


class _DatabaseError(Exception):
    def __init__(self, sqlstate: str, detail: str | None) -> None:
        super().__init__(sqlstate)
        self.sqlstate = sqlstate
        self.detail = detail


def test_task_group_sqlstates_translate_with_a_fallback_for_unreadable_details() -> None:
    closed = _translate_database_error(
        _DatabaseError("P1008", '{"groupId":"g","state":"sealed","reason":"sealed"}')
    )
    assert isinstance(closed, TaskGroupClosedError)
    assert (closed.group_id, closed.state, closed.reason) == ("g", "sealed", "sealed")

    limit = _translate_database_error(_DatabaseError("P1009", "not json"))
    assert isinstance(limit, TaskGroupLimitExceededError)
    assert (limit.group_id, limit.limit, limit.total, limit.requested) == (
        "unknown",
        MAX_TASK_GROUP_MEMBERS,
        0,
        0,
    )

    assert isinstance(limit.details, dict)
    limit.details["total"] = 7
    again = _translate_database_error(_DatabaseError("P1009", None))
    assert isinstance(again, TaskGroupLimitExceededError) and again.total == 0

    conflict = _translate_database_error(_DatabaseError("P1010", '{"groupId":"g"}'))
    assert isinstance(conflict, TaskGroupMembershipConflictError)
    assert (conflict.group_id, conflict.task_id, conflict.ordinal, conflict.member_of) == (
        "unknown",
        "unknown",
        0,
        None,
    )
