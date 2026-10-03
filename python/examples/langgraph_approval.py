from __future__ import annotations

import hashlib
import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any, TypedDict, cast
from uuid import uuid4

import psycopg
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, Interrupt, interrupt
from langsmith import tracing_context
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from workhorse import Admin, EnqueueOptions, HandlerContext, Json, Queue, Worker

WAIT_NAME = "langgraph-approval"
VERSION = "draft-approval-local-note-v1"
DDL = """
CREATE SCHEMA IF NOT EXISTS langgraph_example;
CREATE SCHEMA IF NOT EXISTS langgraph_example_graph;
CREATE TABLE IF NOT EXISTS langgraph_example.bridge (
    task_id uuid PRIMARY KEY,
    thread_id text UNIQUE NOT NULL,
    version text NOT NULL,
    phase text NOT NULL CHECK (phase IN ('preparing', 'interrupted', 'resuming', 'finished')),
    interrupt_id text,
    approval_context jsonb,
    resume_id text UNIQUE,
    decision jsonb,
    stop_reason text,
    outcome text
);
CREATE TABLE IF NOT EXISTS langgraph_example.tool_effect (
    effect_id text PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES langgraph_example.bridge(task_id),
    result jsonb NOT NULL
);
"""


class GraphState(TypedDict, total=False):
    task_id: str
    draft: str
    outcome: str
    result: dict[str, Json]


class DriverBusy(RuntimeError):
    pass


class DecisionConflict(ValueError):
    pass


def no_fault(_point: str) -> None:
    pass


def install(database_url: str) -> None:
    with psycopg.connect(database_url, autocommit=True, row_factory=dict_row) as connection:
        connection.execute("SELECT pg_advisory_lock(%s)", (lock_key("langgraph-example-schema"),))
        connection.execute(DDL)
        connection.execute("SET search_path TO langgraph_example_graph")
        PostgresSaver(connection).setup()


def lock_key(identity: str) -> int:
    return int.from_bytes(hashlib.sha256(identity.encode()).digest()[:8], "big", signed=True)


def normalize_decision(value: Json) -> dict[str, Json]:
    if not isinstance(value, dict) or set(value) != {"approved"}:
        raise ValueError("approval must contain only an approved boolean")
    if not isinstance(value["approved"], bool):
        raise ValueError("approved must be a boolean")
    return {"approved": value["approved"]}


class Driver:
    def __init__(
        self,
        connection: psycopg.Connection[dict[str, Any]],
        task_id: str,
        authorize: Callable[[], None],
        fault: Callable[[str], None],
    ) -> None:
        self.connection = connection
        self.task_id = task_id
        self.authorize = authorize
        self.fault = fault
        self.config: RunnableConfig = {"configurable": {"thread_id": f"workhorse:{task_id}"}}
        saver = PostgresSaver(
            connection,
            serde=JsonPlusSerializer(
                pickle_fallback=False, allowed_json_modules=[], allowed_msgpack_modules=[]
            ),
        )
        builder = StateGraph(GraphState)
        builder.add_node("draft", self.draft)
        builder.add_node("approval", self.approval)
        builder.add_node("tool", self.tool)
        builder.add_edge(START, "draft")
        builder.add_edge("draft", "approval")
        builder.add_conditional_edges(
            "approval", lambda state: "tool" if state["outcome"] == "approved" else END
        )
        builder.add_edge("tool", END)
        self.graph = builder.compile(checkpointer=saver)

    def row(self) -> dict[str, Any]:
        row = self.connection.execute(
            "SELECT * FROM langgraph_example.bridge WHERE task_id = %s", (self.task_id,)
        ).fetchone()
        if row is None or row["version"] != VERSION:
            raise RuntimeError("missing or incompatible bridge; do not restart its graph")
        return row

    def draft(self, state: GraphState) -> GraphState:
        self.authorize()
        return {"draft": f"Deterministic local note for {state['task_id']}"}

    def approval(self, state: GraphState) -> GraphState:
        self.authorize()
        decision = interrupt(
            {"task_id": state["task_id"], "draft": state["draft"], "tool": "record_local_note"}
        )
        if "stop" in decision:
            return {"outcome": decision["stop"]}
        return {"outcome": "approved" if decision["approved"] else "rejected"}

    def tool(self, state: GraphState) -> GraphState:
        self.fault("before_tool")
        self.authorize()
        if state["outcome"] != "approved":
            return {}
        effect_id = self.row()["resume_id"]
        result: dict[str, Json] = {"note": state["draft"]}
        self.connection.execute(
            "INSERT INTO langgraph_example.tool_effect VALUES (%s, %s, %s) "
            "ON CONFLICT (effect_id) DO NOTHING",
            (effect_id, self.task_id, Jsonb(result)),
        )
        saved = self.connection.execute(
            "SELECT task_id, result FROM langgraph_example.tool_effect WHERE effect_id = %s",
            (effect_id,),
        ).fetchone()
        if saved is None or str(saved["task_id"]) != self.task_id or saved["result"] != result:
            raise DecisionConflict("local tool identity reused with a different effect")
        self.fault("tool_saved")
        return {"result": result}

    def prepare(self) -> dict[str, Json]:
        self.authorize()
        self.connection.execute(
            "INSERT INTO langgraph_example.bridge (task_id, thread_id, version, phase) "
            "VALUES (%s, %s, %s, 'preparing') ON CONFLICT (task_id) DO NOTHING",
            (self.task_id, self.config["configurable"]["thread_id"], VERSION),
        )
        retained = self.row()
        snapshot = self.graph.get_state(self.config)
        if not snapshot.values:
            if retained["phase"] != "preparing" or retained["interrupt_id"] is not None:
                raise RuntimeError("retained bridge lost its graph; restore it, do not restart it")
            self.graph.invoke({"task_id": self.task_id}, self.config, durability="sync")
        elif snapshot.next and not snapshot.interrupts:
            self.graph.invoke(None, self.config, durability="sync")
        self.fault("graph_saved")
        snapshot = self.graph.get_state(self.config)
        if snapshot.interrupts:
            if len(snapshot.interrupts) != 1:
                raise RuntimeError("this recipe supports exactly one approval interrupt")
            self.retain_interrupt(snapshot.interrupts[0])
        elif not snapshot.next and "outcome" in snapshot.values:
            self.finish(snapshot.values["outcome"])
        else:
            raise RuntimeError("graph has neither an approval nor a terminal outcome")
        return self.receipt()

    def retain_interrupt(self, pending: Interrupt) -> None:
        row = self.row()
        if row["interrupt_id"] not in {None, pending.id} or (
            row["approval_context"] is not None and row["approval_context"] != pending.value
        ):
            raise DecisionConflict("graph interrupt identity or context changed")
        resume_id = hashlib.sha256(
            f"{row['thread_id']}:{pending.id}:{VERSION}".encode()
        ).hexdigest()
        phase = "interrupted" if row["decision"] is None else "resuming"
        self.connection.execute(
            "UPDATE langgraph_example.bridge SET phase = %s, interrupt_id = %s, "
            "approval_context = %s, resume_id = %s WHERE task_id = %s",
            (phase, pending.id, Jsonb(pending.value), resume_id, self.task_id),
        )

    def receipt(self) -> dict[str, Json]:
        row = self.row()
        return {
            "thread_id": row["thread_id"],
            "interrupt_id": row["interrupt_id"],
            "resume_id": row["resume_id"],
            "context": row["approval_context"],
        }

    def finish(self, outcome: str) -> None:
        self.connection.execute(
            "UPDATE langgraph_example.bridge SET phase = 'finished', outcome = %s "
            "WHERE task_id = %s",
            (outcome, self.task_id),
        )

    def resume(self, decision: dict[str, Json]) -> dict[str, Json]:
        decision = normalize_decision(decision)
        self.authorize()
        row = self.row()
        if row["decision"] is not None and row["decision"] != decision:
            raise DecisionConflict("approval identity already has a different decision")
        self.connection.execute(
            "UPDATE langgraph_example.bridge SET decision = %s, phase = 'resuming' "
            "WHERE task_id = %s",
            (Jsonb(decision), self.task_id),
        )
        self.fault("decision_saved")
        return self.advance(decision)

    def advance(self, decision: dict[str, Json]) -> dict[str, Json]:
        row = self.row()
        snapshot = self.graph.get_state(self.config)
        if snapshot.interrupts:
            if [pending.id for pending in snapshot.interrupts] != [row["interrupt_id"]]:
                raise DecisionConflict("resume does not address the retained interrupt")
            self.graph.invoke(
                Command(resume={row["interrupt_id"]: decision}), self.config, durability="sync"
            )
        elif snapshot.next:
            self.graph.invoke(None, self.config, durability="sync")
        self.fault("resume_saved")
        snapshot = self.graph.get_state(self.config)
        if snapshot.next or "outcome" not in snapshot.values:
            raise RuntimeError("graph did not reach its terminal outcome")
        self.finish(snapshot.values["outcome"])
        return {**self.receipt(), "outcome": snapshot.values["outcome"]}

    def stop(self, reason: str) -> dict[str, Json]:
        self.authorize()
        self.row()
        self.connection.execute(
            "UPDATE langgraph_example.bridge SET stop_reason = %s WHERE task_id = %s",
            (reason, self.task_id),
        )
        snapshot = self.graph.get_state(self.config)
        if snapshot.interrupts:
            if len(snapshot.interrupts) != 1:
                raise RuntimeError("this recipe supports exactly one approval interrupt")
            self.retain_interrupt(snapshot.interrupts[0])
        if snapshot.next and not snapshot.interrupts:
            self.graph.update_state(self.config, {"outcome": reason}, as_node="approval")
        return self.advance({"stop": reason})


@contextmanager
def driver(
    database_url: str,
    task_id: str,
    authorize: Callable[[], None],
    fault: Callable[[str], None] = no_fault,
) -> Iterator[Driver]:
    with psycopg.connect(
        database_url, autocommit=True, row_factory=dict_row, prepare_threshold=0
    ) as connection:
        locked = connection.execute(
            "SELECT pg_try_advisory_lock(%s) AS locked", (lock_key(f"workhorse:{task_id}"),)
        ).fetchone()
        if locked is None or not locked["locked"]:
            raise DriverBusy("another session owns this graph; retry without invoking it")
        connection.execute("SET search_path TO langgraph_example_graph")
        with tracing_context(enabled=False):
            yield Driver(connection, task_id, authorize, fault)


def handler(
    database_url: str, fault: Callable[[str], None] = no_fault, timeout_ms: int = 60_000
) -> Callable[[Json, HandlerContext], Json]:
    def handle(_payload: Json, context: HandlerContext) -> Json:
        def authorize() -> None:
            context.set_progress({"langgraph_thread": f"workhorse:{context.task.id}"})

        with driver(database_url, context.task.id, authorize, fault) as session:
            receipt = session.prepare()
        context.checkpoint("langgraph-interrupt-receipt", lambda: receipt)
        decision = normalize_decision(
            context.wait_for_human(WAIT_NAME, receipt["context"], timeout_ms=timeout_ms)
        )
        with driver(database_url, context.task.id, authorize, fault) as session:
            completed = session.resume(decision)
        fault("before_workhorse_receipt")
        return context.checkpoint("langgraph-resume-receipt", lambda: completed)

    return handle


def reconcile_terminal(database_url: str, task_id: str) -> dict[str, Json]:
    with psycopg.connect(database_url, autocommit=True) as observer:

        def authorize() -> None:
            task = Admin(observer).get_task(task_id)
            if task is None or task.state not in {"canceled", "failed"}:
                raise ValueError(
                    "terminal reconciliation requires a retained cancelled/failed task"
                )

        authorize()
        task = Admin(observer).get_task(task_id)
        assert task is not None
        error = cast(dict[str, Any], task.error or {})
        reason = "cancelled" if task.state == "canceled" else "failed"
        if error.get("name") == "DeadlineExceeded":
            reason = "timed_out"
        with driver(database_url, task_id, authorize) as session:
            return session.stop(reason)


def run(database_url: str) -> dict[str, Json]:
    install(database_url)
    queue_name = f"langgraph-example-{uuid4().hex}"
    with psycopg.connect(database_url, autocommit=True) as connection:
        queue = Queue(connection, default_queue=queue_name)
        task_id = queue.enqueue(
            "langgraph.local-note",
            {},
            EnqueueOptions(max_attempts=5, retry_policy={"type": "fixed", "delayMs": 0}),
        )
        with ConnectionPool(
            database_url, min_size=3, max_size=5, kwargs={"autocommit": True}
        ) as pool:
            worker = Worker(pool, queue=queue_name).handle(
                "langgraph.local-note", handler(database_url)
            )
            worker.run_once()
            waits = Admin(connection).list_human_waits().items
            assert any(wait.task_id == task_id for wait in waits)
            queue.complete_human_wait(
                task_id,
                WAIT_NAME,
                {"approved": True},
                requested_by="deterministic-example-reviewer",
                idempotency_key=f"approve:{task_id}",
            )
            worker.run_once()
            task = Admin(connection).get_task(task_id)
            assert task is not None and task.state == "succeeded"
            return cast(dict[str, Json], task.result)


if __name__ == "__main__":
    print(run(os.environ["DATABASE_URL_PRIMARY"]))
