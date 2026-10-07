from __future__ import annotations
# ruff: noqa


import os
import signal
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from threading import Event, Lock, Timer
from time import monotonic, sleep
from typing import Any, cast

import psycopg
import pytest
from eventual_conditions import eventually

from workhorse import ClaimedTask, Queue, Worker, run_worker_process
from workhorse._statements import STATEMENTS, DriverStatement

PROCESS_RUNNER_FIXTURE = Path(__file__).parent / "fixtures" / "process_runner.py"
CRASH_FIXTURE = Path(__file__).parent / "fixtures" / "crash_worker.py"
EXITING_FIXTURE = Path(__file__).parent / "fixtures" / "exiting_worker.py"
DEDICATED_WORKER_EXAMPLE = Path(__file__).parents[1] / "examples" / "dedicated_worker.py"
worker_pool: Any

pytestmark = pytest.mark.slow


def _start_fixture(mode: str, timeout_ms: int) -> subprocess.Popen[str]:
    process = subprocess.Popen(
        [sys.executable, str(PROCESS_RUNNER_FIXTURE), mode, str(timeout_ms)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    assert process.stdout.readline().strip() == "ready"
    return process


def _finish(process: subprocess.Popen[str]) -> tuple[str, str]:
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        stdout, stderr = process.communicate()
        pytest.fail(f"process did not exit within 5s; stdout: {stdout!r} stderr: {stderr!r}")
    assert process.stdout is not None
    assert process.stderr is not None
    return process.stdout.read(), process.stderr.read()


def _kill_and_reap(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        process.kill()
    process.communicate(timeout=5)


@pytest.mark.skipif(os.name == "nt", reason="POSIX process signals are required")
@pytest.mark.parametrize("termination_signal", [signal.SIGINT, signal.SIGTERM])
def test_first_termination_signal_stops_claims_and_allows_a_graceful_drain(
    termination_signal: signal.Signals,
) -> None:
    process = _start_fixture("drain", 30_000)

    process.send_signal(termination_signal)

    stdout, stderr = _finish(process)
    assert process.returncode == 0, f"stdout: {stdout!r} stderr: {stderr!r}"
    assert stdout.strip() == "stopping"
    assert stderr == ""


@pytest.mark.skipif(os.name == "nt", reason="POSIX process signals are required")
@pytest.mark.parametrize(
    ("second_signal", "exit_code"),
    [(signal.SIGINT, 130), (signal.SIGTERM, 143)],
)
def test_second_termination_signal_uses_its_conventional_exit_code(
    second_signal: signal.Signals,
    exit_code: int,
) -> None:
    process = _start_fixture("block", 30_000)

    process.send_signal(signal.SIGTERM)
    assert process.stdout is not None
    assert process.stdout.readline().strip() == "stopping"
    process.send_signal(second_signal)

    stdout, stderr = _finish(process)
    assert process.returncode == exit_code, f"stdout: {stdout!r} stderr: {stderr!r}"


@pytest.mark.skipif(os.name == "nt", reason="POSIX process signals are required")
def test_missed_graceful_drain_deadline_exits_with_failure() -> None:
    process = _start_fixture("block", 50)

    process.send_signal(signal.SIGTERM)

    stdout, stderr = _finish(process)
    assert process.returncode == 1, f"stdout: {stdout!r} stderr: {stderr!r}"


def test_shutdown_deadline_rejects_values_outside_the_process_contract() -> None:
    with pytest.raises(ValueError, match="shutdown_timeout_ms"):
        run_worker_process(cast(Worker, object()), shutdown_timeout_ms=0)


@pytest.mark.skipif(os.name == "nt", reason="POSIX process signals are required")
def test_signal_between_handler_installation_and_worker_run_is_not_lost() -> None:
    process = _start_fixture("pre-run-signal", 30_000)

    stdout, stderr = _finish(process)
    assert process.returncode == 0, f"stdout: {stdout!r} stderr: {stderr!r}"
    assert stdout.strip() == "stopping"
    assert stderr == ""


@pytest.mark.skipif(os.name == "nt", reason="POSIX process signals are required")
@pytest.mark.parametrize("mode", ["state-lock", "state-lock-late-wait"])
def test_signal_while_main_thread_holds_worker_state_lock_still_drains(mode: str) -> None:
    # The late-wait mode delivers the signal before the main thread starts waiting.
    process = _start_fixture(mode, 30_000)

    process.send_signal(signal.SIGTERM)

    stdout, stderr = _finish(process)
    assert process.returncode == 0, f"stdout: {stdout!r} stderr: {stderr!r}"
    assert stdout.strip() == "stopping"
    assert stderr == ""


STALLED_TYPE = "process.stalled"


def _task_row(sequence: int) -> dict[str, object]:
    return {
        "task_id": f"00000000-0000-0000-0000-{sequence:012d}",
        "task_type": STALLED_TYPE,
        "priority": 0,
        "payload": {},
        "contract_version": None,
        "result_max_bytes": 1_048_576,
        "redact_error_details": False,
        "trace_context": None,
        "attempt": 1,
        "max_attempts": 3,
        "retry_policy": None,
        "deadline_at": None,
        "execution_timeout_ms": None,
        "attempt_timeout_at": None,
        "fence_token": 1,
        "lease_expires_at": None,
    }


class FullTierRejection(Exception):
    """The error a full-tier queue raises for a fast claim, as a driver reports it."""

    sqlstate = "P1007"
    detail = '{"queue": "process", "feature": "batched completion"}'


class FailingDatabase:
    """Answer the first claim from a backlog, then fail the next claim or the startup tick.

    The failure waits until a handler runs, so the worker observes it with work still active.
    """

    def __init__(self, rows: int, *, fail: str, handler_started: Event) -> None:
        self._lock = Lock()
        self._backlog = [_task_row(sequence) for sequence in range(rows)]
        self._fail = fail
        self._handler_started = handler_started
        self._claims = 0

    def rows(self, statement: DriverStatement, parameters: Sequence[object] = ()) -> list[Any]:
        if statement is STATEMENTS.complete_many_and_claim:
            raise FullTierRejection
        if statement is STATEMENTS.tick and self._fail == "tick":
            assert self._handler_started.wait(timeout=5)
            raise RuntimeError("tick failed")
        if statement is not STATEMENTS.claim_many:
            return []
        with self._lock:
            self._claims += 1
            first = self._claims == 1
            claimed, self._backlog = self._backlog, []
        if first:
            return claimed
        if self._fail == "claim":
            assert self._handler_started.wait(timeout=5)
            raise RuntimeError("claim failed")
        return []


class StalledHandlers:
    """Stand in for task execution. The first task ignores cancellation until released.

    With fail_execution set, the second execution raises. A failed settlement write leaves
    _execute_claimed_task the same way, so the worker records it as the same fatal run error.
    """

    def __init__(self, *, fail_execution: bool = False) -> None:
        self._lock = Lock()
        self._fail_execution = fail_execution
        self.started = Event()
        self.released = Event()
        self._executions = 0

    def execute(self, _task: ClaimedTask, _claim_sent_at: float) -> None:
        with self._lock:
            self._executions += 1
            first = self._executions == 1
        if first:
            self.started.set()
            self.released.wait(timeout=10)
            return
        assert self.started.wait(timeout=5)
        if self._fail_execution:
            raise RuntimeError("execution failed")


def _stalling_worker(database: FailingDatabase, handlers: StalledHandlers) -> Worker:
    worker = Worker(
        object(),  # type: ignore[arg-type]
        queue="process",
        worker_id="python-process-fatal",
        concurrency=2,
        poll_ms=10,
        registry_interval_ms=0,
        shared_heartbeats=True,
        _executor=database,
    )
    worker._compatibility.assert_compatible = lambda: None  # type: ignore[method-assign]
    worker._notification_connection_factory = None  # type: ignore[assignment]
    worker._execute_claimed_task = handlers.execute  # type: ignore[method-assign]
    return worker.handle(STALLED_TYPE, lambda _payload, _context: None)


def _run_until_released(
    worker: Worker, handlers: StalledHandlers, *, shutdown_timeout_ms: int
) -> tuple[list[int], BaseException | None]:
    """Run the process in this thread. A fake force_exit records its code and frees the handler.

    A watchdog frees the handler after 5 s, so a deadline that never fires fails the test.
    """
    exits: list[int] = []

    def force_exit(code: int) -> None:
        exits.append(code)
        handlers.released.set()

    watchdog = Timer(5, handlers.released.set)
    watchdog.daemon = True
    watchdog.start()
    error: BaseException | None = None
    try:
        run_worker_process(
            worker,
            shutdown_timeout_ms=shutdown_timeout_ms,
            force_exit=force_exit,  # type: ignore[arg-type]
        )
    except RuntimeError as raised:
        error = raised
    finally:
        watchdog.cancel()
    return exits, error


# SM-1175: a fatal worker error never armed the deadline, so a handler that ignored cancellation
# held the drain, and the process, open forever.
@pytest.mark.parametrize(
    ("fail", "rows", "fail_execution", "message"),
    [
        ("claim", 1, False, "claim failed"),
        ("tick", 1, False, "tick failed"),
        ("none", 2, True, "execution failed"),
    ],
)
def test_fatal_worker_error_starts_the_deadline_while_a_handler_ignores_cancellation(
    fail: str, rows: int, fail_execution: bool, message: str
) -> None:
    handlers = StalledHandlers(fail_execution=fail_execution)
    database = FailingDatabase(rows, fail=fail, handler_started=handlers.started)
    worker = _stalling_worker(database, handlers)

    started_at = monotonic()
    exits, error = _run_until_released(worker, handlers, shutdown_timeout_ms=50)

    assert exits == [1]
    assert monotonic() - started_at < 4
    assert str(error) == message


def test_fatal_worker_error_drained_before_the_deadline_cancels_it() -> None:
    handlers = StalledHandlers()
    handlers.started.set()
    handlers.released.set()
    database = FailingDatabase(1, fail="claim", handler_started=handlers.started)
    worker = _stalling_worker(database, handlers)

    exits, error = _run_until_released(worker, handlers, shutdown_timeout_ms=200)
    sleep(0.4)

    assert exits == []
    assert str(error) == "claim failed"


@pytest.mark.integration
@pytest.mark.skipif(os.name == "nt", reason="POSIX process signals are required")
def test_killed_worker_task_is_recovered_and_completed_once(
    database_url: str,
    tmp_path: Path,
) -> None:
    started = tmp_path / "handler-started"
    with psycopg.connect(database_url) as enqueue_connection:
        task_id = Queue(enqueue_connection).enqueue("process.crash-recovery", {})
        enqueue_connection.commit()

    crashed = subprocess.Popen(
        [sys.executable, str(CRASH_FIXTURE), database_url, str(started)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = monotonic() + 5
        while not started.exists() and monotonic() < deadline:
            sleep(0.01)
        assert started.exists()
        _kill_and_reap(crashed)
        assert crashed.returncode is not None

        completions = 0
        with psycopg.connect(database_url, autocommit=True) as recovery_connection:

            def complete(_payload: object, _context: object) -> dict[str, bool]:
                nonlocal completions
                completions += 1
                return {"recovered": True}

            worker = Worker(
                worker_pool,
                worker_id="python-recovery-worker",
            ).handle("process.crash-recovery", complete)
            eventually(worker.run_once, "the killed worker's lease was never recovered")
            outcome = recovery_connection.execute(
                "SELECT state, current_attempt, result FROM workhorse.task_outcome "
                "WHERE task_id = %s",
                (task_id,),
            ).fetchone()
            assert outcome == ("succeeded", 2, {"recovered": True})
            assert completions == 1
    finally:
        _kill_and_reap(crashed)


@pytest.mark.integration
def test_built_wheel_runs_a_worker_for_a_clean_consumer(
    database_url: str,
    tmp_path: Path,
    installed_distribution_interpreters: dict[str, Path],
) -> None:
    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)
    result = subprocess.run(
        [
            str(installed_distribution_interpreters["wheel"]),
            str(DEDICATED_WORKER_EXAMPLE),
            database_url,
        ],
        check=False,
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.integration
def test_handler_system_exit_releases_ownership_and_exits_the_process(database_url: str) -> None:
    with psycopg.connect(database_url) as enqueue_connection:
        task_id = Queue(enqueue_connection).enqueue("process.system-exit", {})
        enqueue_connection.commit()

    exiting = subprocess.Popen(
        [sys.executable, str(EXITING_FIXTURE), database_url, "3"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdout, stderr = _finish(exiting)
    assert exiting.returncode == 3, f"stdout: {stdout!r} stderr: {stderr!r}"

    # The exited worker renews nothing, so its lease lapses and another worker takes the task.
    completions = 0
    with psycopg.connect(database_url, autocommit=True) as recovery_connection:

        def complete(_payload: object, _context: object) -> dict[str, bool]:
            nonlocal completions
            completions += 1
            return {"recovered": True}

        worker = Worker(
            worker_pool,
            worker_id="python-exit-recovery-worker",
        ).handle("process.system-exit", complete)
        eventually(worker.run_once, "the exited worker's lease was never released")
        outcome = recovery_connection.execute(
            "SELECT state, current_attempt, result FROM workhorse.task_outcome WHERE task_id = %s",
            (task_id,),
        ).fetchone()
    assert outcome == ("succeeded", 2, {"recovered": True})
    assert completions == 1
