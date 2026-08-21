from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path
from time import monotonic, sleep

import psycopg
import pytest

PROCESS_RUNNER_FIXTURE = Path(__file__).parent / "fixtures" / "process_runner.py"
CRASH_FIXTURE = Path(__file__).parent / "fixtures" / "crash_worker.py"
PACKED_FIXTURE = Path(__file__).parent / "fixtures" / "packed_consumer.py"


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
        return process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        raise


def _kill_and_reap(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        process.kill()
    process.communicate(timeout=5)


@pytest.mark.skipif(os.name == "nt", reason="POSIX process signals are required")
@pytest.mark.parametrize("termination_signal", [signal.SIGINT, signal.SIGTERM])
def test_first_termination_signal_stops_claims_and_allows_a_graceful_drain(
    termination_signal: signal.Signals,
) -> None:
    process = _start_fixture("drain", 1_000)

    process.send_signal(termination_signal)

    stdout, stderr = _finish(process)
    assert process.returncode == 0
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
    process = _start_fixture("block", 5_000)

    process.send_signal(signal.SIGTERM)
    assert process.stdout is not None
    assert process.stdout.readline().strip() == "stopping"
    process.send_signal(second_signal)

    _finish(process)
    assert process.returncode == exit_code


@pytest.mark.skipif(os.name == "nt", reason="POSIX process signals are required")
def test_missed_graceful_drain_deadline_exits_with_failure() -> None:
    process = _start_fixture("block", 50)

    process.send_signal(signal.SIGTERM)

    _finish(process)
    assert process.returncode == 1


def test_shutdown_deadline_rejects_values_outside_the_process_contract() -> None:
    from typing import cast

    from workhorse import Worker, run_worker_process

    with pytest.raises(ValueError, match="shutdown_timeout_ms"):
        run_worker_process(cast(Worker, object()), shutdown_timeout_ms=0)


@pytest.mark.skipif(os.name == "nt", reason="POSIX process signals are required")
def test_signal_between_handler_installation_and_worker_run_is_not_lost() -> None:
    process = _start_fixture("pre-run-signal", 1_000)

    stdout, stderr = _finish(process)
    assert process.returncode == 0
    assert stdout.strip() == "stopping"
    assert stderr == ""


@pytest.mark.integration
@pytest.mark.skipif(os.name == "nt", reason="POSIX process signals are required")
def test_killed_worker_job_is_recovered_and_completed_once(
    database_url: str,
    tmp_path: Path,
) -> None:
    from workhorse import Queue, Worker

    started = tmp_path / "handler-started"
    with psycopg.connect(database_url) as enqueue_connection:
        job_id = Queue(enqueue_connection).enqueue("process.crash-recovery", {})
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

        sleep(0.25)
        completions = 0
        with psycopg.connect(database_url, autocommit=True) as recovery_connection:

            def complete(_payload: object, _context: object) -> dict[str, bool]:
                nonlocal completions
                completions += 1
                return {"recovered": True}

            worker = Worker(
                recovery_connection,
                worker_id="python-recovery-worker",
            ).handle("process.crash-recovery", complete)
            assert worker.run_once() is True
            outcome = recovery_connection.execute(
                "SELECT state, current_attempt, result FROM workhorse.job_outcome "
                "WHERE job_id = %s",
                (job_id,),
            ).fetchone()
            assert outcome == ("succeeded", 2, {"recovered": True})
            assert completions == 1
    finally:
        _kill_and_reap(crashed)


@pytest.mark.integration
def test_built_wheel_runs_a_worker_for_a_clean_consumer(
    database_url: str,
    tmp_path: Path,
) -> None:
    repository = Path(__file__).parents[2]
    distribution_directory = tmp_path / "dist"
    environment_directory = tmp_path / "consumer-environment"
    subprocess.run(
        [
            "uv",
            "build",
            "--project",
            str(repository / "python"),
            "--out-dir",
            str(distribution_directory),
        ],
        check=True,
        cwd=repository,
    )
    wheel = next(distribution_directory.glob("*.whl"))
    subprocess.run(
        ["uv", "venv", str(environment_directory), "--python", sys.executable],
        check=True,
        cwd=repository,
    )
    installed_python = environment_directory / "bin" / "python"
    subprocess.run(
        [
            "uv",
            "pip",
            "install",
            "--python",
            str(installed_python),
            f"{wheel}[psycopg]",
        ],
        check=True,
        cwd=repository,
    )

    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)
    result = subprocess.run(
        [str(installed_python), str(PACKED_FIXTURE), database_url],
        check=False,
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
