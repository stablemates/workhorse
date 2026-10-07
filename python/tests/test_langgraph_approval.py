from __future__ import annotations

import importlib.util
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from threading import Event, Thread
from time import sleep
from typing import Any

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from workhorse import (
    Admin,
    EnqueueOptions,
    HandlerContext,
    HumanWaitIdempotencyConflictError,
    Json,
    ProgressLeaseLostError,
    Queue,
    StaleLeaseError,
    Worker,
)

spec = importlib.util.spec_from_file_location(
    "langgraph_approval", Path(__file__).parents[1] / "examples" / "langgraph_approval.py"
)
assert spec is not None and spec.loader is not None
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)


class Harness:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self.contexts: list[HandlerContext] = []
        self.crash_at: str | None = None
        self.pause_at: str | None = None
        self.entered = Event()
        self.release = Event()
        self.connection = psycopg.connect(database_url, autocommit=True, row_factory=dict_row)
        self.pool = ConnectionPool(
            database_url, min_size=3, max_size=6, kwargs={"autocommit": True}, open=True
        )
        self.queue = Queue(self.connection, default_queue="langgraph-fixture")
        self.task_id = self.queue.enqueue(
            "langgraph.local-note",
            {},
            EnqueueOptions(max_attempts=10, retry_policy={"type": "fixed", "delayMs": 60_000}),
        )
        self.worker = self.new_worker("initial")

    def fault(self, point: str) -> None:
        if point == self.crash_at:
            self.crash_at = None
            raise RuntimeError(f"injected crash at {point}")
        if point == self.pause_at:
            self.pause_at = None
            self.entered.set()
            if not self.release.wait(10):
                raise TimeoutError("test did not release its paused driver")

    def new_worker(self, name: str, timeout_ms: int = 60_000) -> Worker:
        implementation = bridge.handler(self.database_url, self.fault, timeout_ms)

        def handle(payload: Json, context: HandlerContext) -> Json:
            self.contexts.append(context)
            return implementation(payload, context)

        return Worker(self.pool, queue="langgraph-fixture", worker_id=name).handle(
            "langgraph.local-note", handle
        )

    def row(self) -> dict[str, Any]:
        row = self.connection.execute(
            "SELECT * FROM langgraph_example.bridge WHERE task_id = %s", (self.task_id,)
        ).fetchone()
        assert row is not None
        return row

    def step(self, worker: Worker | None = None) -> bool:
        self.connection.execute(
            "UPDATE workhorse.task_runtime SET run_at = clock_timestamp() "
            "WHERE task_id = %s AND state = 'scheduled' AND wait_name IS NULL",
            (self.task_id,),
        )
        self.connection.execute("SELECT workhorse.tick_v1()")
        return (worker or self.worker).run_once()

    def snapshot(self) -> Any:
        with bridge.driver(self.database_url, self.task_id, lambda: None) as session:
            return session.graph.get_state(session.config)

    def approve(self, approved: bool = True) -> Any:
        return self.queue.complete_human_wait(
            self.task_id,
            bridge.WAIT_NAME,
            {"approved": approved},
            requested_by="fixture-reviewer",
            idempotency_key=f"approve:{self.task_id}",
        )

    def effects(self) -> int:
        row = self.connection.execute(
            "SELECT count(*) AS count FROM langgraph_example.tool_effect WHERE task_id = %s",
            (self.task_id,),
        ).fetchone()
        assert row is not None
        return int(row["count"])

    def state(self) -> str:
        task = Admin(self.connection).get_task(self.task_id)
        assert task is not None
        return task.state

    def close(self) -> None:
        self.release.set()
        self.pool.close()
        self.connection.close()


@pytest.fixture
def harness(database_url: str) -> Iterator[Harness]:
    bridge.install(database_url)
    case = Harness(database_url)
    try:
        yield case
    finally:
        case.close()


def test_executable_example_uses_real_postgres_checkpointer(database_url: str) -> None:
    result = bridge.run(database_url)
    assert result["outcome"] == "approved"
    assert result["interrupt_id"]
    assert result["resume_id"]
    with psycopg.connect(database_url) as connection:
        assert (
            connection.execute(
                "SELECT count(*) FROM langgraph_example_graph.checkpoints"
            ).fetchone()[0]
            > 1
        )
        assert connection.execute(
            "SELECT count(*) FROM langgraph_example.tool_effect"
        ).fetchone() == (1,)


def test_graph_and_tool_recover_after_actual_interpreter_restart(harness: Harness) -> None:
    program = """
import sys
from psycopg_pool import ConnectionPool
from langgraph_approval import handler
from workhorse import Worker
def fault(point):
    if point == sys.argv[2]:
        raise RuntimeError('child receipt loss')
with ConnectionPool(sys.argv[1], min_size=3, max_size=5,
                    kwargs={'autocommit': True}) as pool:
    Worker(pool, queue='langgraph-fixture').handle(
        'langgraph.local-note', handler(sys.argv[1], fault)
    ).run_once()
"""

    def child(point: str) -> None:
        subprocess.run(
            [sys.executable, "-c", program, harness.database_url, point],
            cwd=Path(__file__).parents[1] / "examples",
            check=True,
            timeout=20,
        )

    child("none")
    original = harness.row()
    harness.approve()
    child("tool_saved")
    assert harness.effects() == 1
    harness.connection.execute(
        "UPDATE workhorse.task_runtime SET run_at = clock_timestamp() WHERE task_id = %s",
        (harness.task_id,),
    )
    harness.connection.execute("SELECT workhorse.tick_v1()")
    child("none")
    assert harness.state() == "succeeded"
    assert harness.row()["resume_id"] == original["resume_id"]
    assert harness.effects() == 1


@pytest.mark.parametrize("approved", [True, False])
def test_committed_wait_retains_context_and_receipts_not_graph_snapshots(
    harness: Harness, approved: bool
) -> None:
    assert harness.step()
    retained = harness.row()
    wait = Admin(harness.connection).list_human_waits().items[0]
    assert wait.context == retained["approval_context"]
    assert retained["phase"] == "interrupted"
    assert harness.state() == "scheduled"
    assert harness.effects() == 0
    assert harness.snapshot().interrupts[0].id == retained["interrupt_id"]
    harness.approve(approved)
    harness.worker = harness.new_worker("restart")
    assert harness.step()
    assert harness.state() == "succeeded"
    assert harness.row()["outcome"] == ("approved" if approved else "rejected")
    assert harness.effects() == int(approved)
    checkpoints = Admin(harness.connection).list_checkpoints(harness.task_id)
    assert {checkpoint.name for checkpoint in checkpoints} == {
        "langgraph-interrupt-receipt",
        "langgraph-resume-receipt",
    }
    for checkpoint in checkpoints:
        assert set(checkpoint.value) <= {
            "thread_id",
            "interrupt_id",
            "resume_id",
            "context",
            "outcome",
        }
    assert harness.row()["approval_context"] == retained["approval_context"]


def test_graph_save_before_bridge_save_recovers_original_interrupt(harness: Harness) -> None:
    harness.crash_at = "graph_saved"
    assert harness.step()
    assert harness.row()["phase"] == "preparing"
    original = harness.snapshot().interrupts[0]
    assert not Admin(harness.connection).list_human_waits().items
    harness.worker = harness.new_worker("restart")
    assert harness.step()
    assert harness.row()["interrupt_id"] == original.id
    assert harness.row()["approval_context"] == original.value
    assert harness.snapshot().interrupts[0].id == original.id
    harness.approve()
    assert harness.step()
    assert harness.effects() == 1


@pytest.mark.parametrize(
    "point", ["decision_saved", "tool_saved", "resume_saved", "before_workhorse_receipt"]
)
def test_resume_crash_windows_reconcile_without_restarting_graph(
    harness: Harness, point: str
) -> None:
    harness.step()
    original = harness.row()
    harness.approve()
    harness.crash_at = point
    harness.step()
    assert not any(
        checkpoint.name == "langgraph-resume-receipt"
        for checkpoint in Admin(harness.connection).list_checkpoints(harness.task_id)
    )
    assert harness.effects() == int(point != "decision_saved")
    harness.worker = harness.new_worker("restart")
    harness.step()
    assert harness.state() == "succeeded"
    recovered = harness.row()
    for key in ("thread_id", "interrupt_id", "resume_id", "approval_context"):
        assert recovered[key] == original[key]
    assert recovered["phase"] == "finished"
    assert recovered["decision"] == {"approved": True}
    assert harness.effects() == 1
    assert not harness.snapshot().next


def test_uncommitted_approval_is_invisible_to_graph_driver(harness: Harness) -> None:
    harness.step()
    original = harness.row()
    with psycopg.connect(harness.database_url) as request:
        Queue(request).complete_human_wait(
            harness.task_id,
            bridge.WAIT_NAME,
            {"approved": True},
            requested_by="reviewer",
            idempotency_key="uncommitted",
        )
        assert harness.row()["decision"] is None
        assert harness.snapshot().interrupts[0].id == original["interrupt_id"]
        assert harness.effects() == 0
        request.rollback()
    assert harness.state() == "scheduled"
    harness.approve()
    harness.step()
    assert harness.effects() == 1


def test_duplicate_and_conflicting_resume_keep_one_decision_and_effect(harness: Harness) -> None:
    harness.step()
    assert harness.approve().status == "completed"
    assert harness.approve().status == "duplicate"
    with pytest.raises(HumanWaitIdempotencyConflictError):
        harness.approve(False)
    harness.step()
    with bridge.driver(harness.database_url, harness.task_id, lambda: None) as session:
        first = session.resume({"approved": True})
        assert session.resume({"approved": True}) == first
        with pytest.raises(bridge.DecisionConflict):
            session.resume({"approved": False})
    assert harness.effects() == 1


def test_concurrent_resume_cannot_drive_even_with_same_workhorse_lease(harness: Harness) -> None:
    harness.step()
    harness.approve()
    harness.pause_at = "decision_saved"
    thread = Thread(target=harness.step)
    thread.start()
    try:
        assert harness.entered.wait(10)
        current = harness.contexts[-1]
        with pytest.raises(bridge.DriverBusy):
            bridge.handler(harness.database_url)({}, current)
        assert harness.effects() == 0
    finally:
        harness.release.set()
        thread.join(10)
    assert not thread.is_alive()
    assert harness.state() == "succeeded"
    assert harness.effects() == 1


def test_stale_lease_cannot_become_second_or_later_graph_driver(harness: Harness) -> None:
    harness.step()
    original = harness.row()
    harness.approve()
    harness.pause_at = "before_tool"
    thread = Thread(target=harness.step)
    thread.start()
    try:
        assert harness.entered.wait(10)
        stale = harness.contexts[-1]
        harness.connection.execute(
            "UPDATE workhorse.task_runtime "
            "SET expires_at = clock_timestamp() - interval '1 second' "
            "WHERE task_id = %s",
            (harness.task_id,),
        )
        harness.connection.execute("SELECT workhorse.recover_expired_v1()")
        successor = harness.new_worker("successor")
        harness.step(successor)
        assert harness.effects() == 0
        assert harness.row()["resume_id"] == original["resume_id"]
    finally:
        harness.release.set()
        thread.join(10)
    assert not thread.is_alive()
    assert harness.effects() == 0
    harness.step(successor)
    assert harness.state() == "succeeded", Admin(harness.connection).get_task(harness.task_id).error
    assert harness.effects() == 1
    with (
        pytest.raises((ProgressLeaseLostError, StaleLeaseError)),
        bridge.driver(
            harness.database_url,
            harness.task_id,
            lambda: stale.set_progress({"langgraph_thread": f"workhorse:{harness.task_id}"}),
        ) as session,
    ):
        session.prepare()
    assert harness.effects() == 1


def test_lock_connection_loss_disables_old_checkpointer_and_tool(harness: Harness) -> None:
    harness.step()
    with bridge.driver(harness.database_url, harness.task_id, lambda: None) as old:
        backend = old.connection.info.backend_pid
        harness.connection.execute("SELECT pg_terminate_backend(%s)", (backend,))
        with bridge.driver(harness.database_url, harness.task_id, lambda: None) as successor:
            assert successor.graph.get_state(successor.config).interrupts
        with pytest.raises(psycopg.Error):
            old.graph.get_state(old.config)
        with pytest.raises(psycopg.Error):
            old.tool({"outcome": "approved", "draft": "must not commit"})
    assert harness.effects() == 0


@pytest.mark.parametrize("terminal", ["cancel", "timeout"])
def test_suspended_task_terminal_reconciliation_propagates_stop_and_retains_context(
    harness: Harness, terminal: str
) -> None:
    if terminal == "timeout":
        harness.worker = harness.new_worker("short-wait", timeout_ms=50)
    harness.step()
    original = harness.row()
    if terminal == "cancel":
        harness.queue.cancel(harness.task_id, requested_by="reviewer", reason="stop graph")
    else:
        sleep(0.075)
        harness.connection.execute("SELECT workhorse.tick_v1()")
    assert harness.snapshot().interrupts
    result = bridge.reconcile_terminal(harness.database_url, harness.task_id)
    expected = "cancelled" if terminal == "cancel" else "timed_out"
    assert result["outcome"] == expected
    assert harness.row()["stop_reason"] == expected
    assert harness.row()["approval_context"] == original["approval_context"]
    assert harness.effects() == 0
    assert not harness.snapshot().next
    assert bridge.reconcile_terminal(harness.database_url, harness.task_id) == result


def test_live_task_cannot_use_terminal_reconciliation(harness: Harness) -> None:
    harness.step()
    with pytest.raises(ValueError, match="terminal reconciliation"):
        bridge.reconcile_terminal(harness.database_url, harness.task_id)
    assert harness.snapshot().interrupts


def test_cancel_after_graph_save_before_bridge_save_recovers_retained_approval(
    harness: Harness,
) -> None:
    harness.crash_at = "graph_saved"
    harness.step()
    original = harness.snapshot().interrupts[0]
    assert harness.row()["interrupt_id"] is None
    harness.queue.cancel(
        harness.task_id, requested_by="reviewer", reason="cancel crashed admission"
    )
    result = bridge.reconcile_terminal(harness.database_url, harness.task_id)
    assert result["outcome"] == "cancelled"
    assert result["interrupt_id"] == original.id
    assert result["context"] == original.value
    assert harness.effects() == 0


def test_cancel_after_bridge_save_before_first_checkpoint_stops_empty_graph(
    harness: Harness,
) -> None:
    harness.crash_at = "bridge_saved"
    harness.step()
    assert harness.row()["phase"] == "preparing"
    assert not harness.snapshot().values
    harness.queue.cancel(
        harness.task_id, requested_by="reviewer", reason="cancel before first checkpoint"
    )
    result = bridge.reconcile_terminal(harness.database_url, harness.task_id)
    assert result["outcome"] == "cancelled"
    assert result["interrupt_id"] is None
    assert harness.row()["phase"] == "finished"
    assert harness.row()["stop_reason"] == "cancelled"
    assert harness.effects() == 0
    assert not harness.snapshot().next
    assert bridge.reconcile_terminal(harness.database_url, harness.task_id) == result


def test_terminal_reconciliation_fails_closed_when_retained_graph_is_missing(
    harness: Harness,
) -> None:
    harness.step()
    original = harness.row()
    harness.connection.execute(
        "DELETE FROM langgraph_example_graph.checkpoints WHERE thread_id = %s",
        (original["thread_id"],),
    )
    harness.queue.cancel(harness.task_id, requested_by="reviewer", reason="cancel lost graph")
    with pytest.raises(RuntimeError, match="restore it"):
        bridge.reconcile_terminal(harness.database_url, harness.task_id)
    assert not harness.snapshot().values
    assert harness.row()["interrupt_id"] == original["interrupt_id"]
    assert harness.row()["phase"] == "interrupted"
    assert harness.effects() == 0


@pytest.mark.parametrize("value", [{"approved": "yes"}, {"approved": True, "tool": "shell"}, {}])
def test_untrusted_approval_cannot_choose_tools(value: Json) -> None:
    with pytest.raises(ValueError):
        bridge.normalize_decision(value)


def test_incompatible_bridge_version_fails_closed(harness: Harness) -> None:
    harness.step()
    original = harness.snapshot().interrupts[0].id
    harness.connection.execute(
        "UPDATE langgraph_example.bridge SET version = 'incompatible' WHERE task_id = %s",
        (harness.task_id,),
    )
    with bridge.driver(harness.database_url, harness.task_id, lambda: None) as session:
        with pytest.raises(RuntimeError, match="incompatible bridge"):
            session.prepare()
        assert session.graph.get_state(session.config).interrupts[0].id == original
    assert harness.effects() == 0


def test_missing_retained_graph_fails_closed_instead_of_recreating_interrupt(
    harness: Harness,
) -> None:
    harness.step()
    original = harness.row()
    harness.connection.execute(
        "DELETE FROM langgraph_example_graph.checkpoints WHERE thread_id = %s",
        (original["thread_id"],),
    )
    with bridge.driver(harness.database_url, harness.task_id, lambda: None) as session:
        with pytest.raises(RuntimeError, match="restore it"):
            session.prepare()
        assert not session.graph.get_state(session.config).values
    assert harness.row()["interrupt_id"] == original["interrupt_id"]
    assert harness.effects() == 0


@pytest.mark.parametrize("point", ["decision_saved", "tool_saved"])
def test_cancellation_after_resume_receipt_loss_stops_pending_graph_not_committed_effect(
    harness: Harness, point: str
) -> None:
    harness.step()
    original = harness.row()
    harness.approve()
    harness.crash_at = point
    harness.step()
    harness.queue.cancel(harness.task_id, requested_by="reviewer", reason="cancel after crash")
    result = bridge.reconcile_terminal(harness.database_url, harness.task_id)
    assert result["outcome"] == "cancelled"
    assert harness.row()["decision"] == {"approved": True}
    assert harness.row()["approval_context"] == original["approval_context"]
    assert harness.effects() == int(point == "tool_saved")
    assert not harness.snapshot().next
