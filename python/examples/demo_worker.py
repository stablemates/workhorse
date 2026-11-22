"""Serves the Python queues of the hosted dashboard demo at https://demo.workhorse.run, plus the
queue every demo language shares, so the dashboard has live Python work to show.

Documentation: https://workhorse.run/docs/dashboard
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import socket
import sys
import threading
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from opentelemetry._logs import Logger, LoggerProvider, set_logger_provider
from psycopg_pool import ConnectionPool

from workhorse import (
    HandlerContext,
    Json,
    ProtocolCompatibilityError,
    Worker,
    assert_schema_compatible,
    run_worker_process,
)

LANGUAGE_TASK_TYPE = "demo.language-worker"
SHARED_TASK_TYPE = "demo.shared-worker"
PYTHON_QUEUE = "demo-python"
PYTHON_FAST_QUEUE = "demo-python-fast"
SHARED_QUEUE = "demo-shared"
SCHEDULE_NAMESPACE = "workhorse-demo"
FAST_TIER_SCHEDULE_NAMESPACE = "workhorse-demo-fast-tier"
WORKER_CONCURRENCY = 6
DEFAULT_POLL_MS = 15_000
SCHEMA_RETRY_SECONDS = 0.5
DEFAULT_LOG_MAX_BYTES = 10 * 1_024 * 1_024
DEFAULT_LOG_ARCHIVES = 5
# The OpenTelemetry severity numbers of the levels that the demo records.
SEVERITY_NUMBERS = {"DEBUG": 5, "INFO": 9, "WARN": 13, "ERROR": 17, "FATAL": 21}
# A record that the console echo of an OpenTelemetry record makes. The file handler skips it, so
# the file holds that record once.
ECHO_MARKER = "workhorse_demo_echo"
STANDARD_RECORD_FIELDS = frozenset(
    vars(logging.LogRecord("", 0, "", 0, "", None, None)).keys() | {"message", "asctime"}
)


def _safe_path_segment(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]", "_", value)[:100] or "unknown"


def _positive_integer(environment: Mapping[str, str], name: str, fallback: int) -> int:
    value = environment.get(name)
    if value is None:
        return fallback
    try:
        parsed = int(value)
    except ValueError:
        parsed = 0
    if parsed < 1:
        raise RuntimeError(f"{name} must be a positive integer")
    return parsed


def _timestamp(nanoseconds: int | None) -> str:
    moment = (
        datetime.now(UTC) if nanoseconds is None else datetime.fromtimestamp(nanoseconds / 1e9, UTC)
    )
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _finite(value: Any) -> Any:
    """`value` with each NaN or infinite number replaced by None, as `JSON.stringify` writes it."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Mapping):
        return {key: _finite(member) for key, member in value.items()}
    if isinstance(value, list | tuple):
        return [_finite(member) for member in value]
    return value


class DemoLogFile:
    """Writes demo log records as NDJSON, in the format of `typescript/demo/file-log-exporter.cjs`.

    The file rotates before a record would take it past `max_bytes`, and keeps `archives` numbered
    archives. A write that fails reports once to standard error and never reaches the worker.
    """

    def __init__(
        self, path: Path, max_bytes: int, archives: int, resource: Mapping[str, Any]
    ) -> None:
        self.path = path
        self.max_bytes = max_bytes
        self.archives = archives
        self.resource = dict(resource)
        self._lock = threading.Lock()
        self._failed = False

    def write(
        self,
        *,
        severity_text: str,
        body: str,
        scope: str,
        event_name: str | None = None,
        attributes: Mapping[str, Any] | None = None,
        timestamp: int | None = None,
    ) -> None:
        record: dict[str, Any] = {
            "timestamp": _timestamp(timestamp),
            "observedTimestamp": _timestamp(None),
            "severityText": severity_text,
            "severityNumber": SEVERITY_NUMBERS.get(severity_text, 9),
        }
        if event_name is not None:
            record["eventName"] = event_name
        record["body"] = body
        record["attributes"] = dict(attributes or {})
        record["resource"] = self.resource
        record["scope"] = {"name": scope}
        with self._lock:
            try:
                # Strict JSON, as `JSON.stringify` in the TypeScript exporter writes it.
                line = (
                    json.dumps(_finite(record), separators=(",", ":"), default=str, allow_nan=False)
                    + "\n"
                ).encode()
                self.path.parent.mkdir(parents=True, exist_ok=True)
                size = self.path.stat().st_size if self.path.exists() else 0
                if size > 0 and size + len(line) > self.max_bytes:
                    self._rotate()
                with self.path.open("ab") as file:
                    file.write(line)
            except (OSError, TypeError, ValueError) as error:
                if not self._failed:
                    self._failed = True
                    print(
                        f"Could not write the demo log file {self.path}: {error}", file=sys.stderr
                    )

    def _rotate(self) -> None:
        archive = Path(f"{self.path}.{self.archives}")
        archive.unlink(missing_ok=True)
        for index in range(self.archives - 1, 0, -1):
            older = Path(f"{self.path}.{index}")
            if older.exists():
                older.rename(f"{self.path}.{index + 1}")
        self.path.rename(f"{self.path}.1")


def demo_log_file(environment: Mapping[str, str] = os.environ) -> DemoLogFile | None:
    """The log file of this worker, or None when the launcher names no log directory."""
    directory = environment.get("WORKHORSE_DEMO_LOG_DIRECTORY")
    service = environment.get("WORKHORSE_DEMO_SERVICE_NAME")
    if not directory or not service:
        return None
    deployment = environment.get("WORKHORSE_DEMO_ENV") or "development"
    return DemoLogFile(
        Path(directory).resolve()
        / _safe_path_segment(deployment)
        / f"{_safe_path_segment(service)}.ndjson",
        _positive_integer(environment, "WORKHORSE_DEMO_LOG_MAX_BYTES", DEFAULT_LOG_MAX_BYTES),
        _positive_integer(environment, "WORKHORSE_DEMO_LOG_ARCHIVES", DEFAULT_LOG_ARCHIVES),
        {
            "service.name": service,
            "deployment.environment.name": deployment,
            "deployment.environment": deployment,
            "host.name": socket.gethostname(),
            "process.pid": os.getpid(),
            "telemetry.sdk.language": "python",
        },
    )


class DemoLogHandler(logging.Handler):
    """Copies standard-library records, such as `workhorse.worker.reporter_failed`, to the file."""

    def __init__(self, log_file: DemoLogFile) -> None:
        super().__init__(logging.DEBUG)
        self.log_file = log_file

    def emit(self, record: logging.LogRecord) -> None:
        if getattr(record, ECHO_MARKER, False):
            return
        extra = {
            key: value for key, value in vars(record).items() if key not in STANDARD_RECORD_FIELDS
        }
        event_name = extra.pop("event.name", None)
        level = {"WARNING": "WARN", "CRITICAL": "FATAL"}.get(record.levelname, record.levelname)
        self.log_file.write(
            severity_text=level,
            event_name=event_name if isinstance(event_name, str) else None,
            body=record.getMessage(),
            attributes=extra,
            scope=record.name,
            timestamp=int(record.created * 1e9),
        )


class DemoLogger(Logger):
    """Echoes each OpenTelemetry record to `logging` and writes it to the file."""

    def __init__(self, name: str, log_file: DemoLogFile | None) -> None:
        super().__init__(name)
        self.log_file = log_file

    def enabled(self, **_fields: Any) -> bool:
        return True

    def emit(self, record: Any = None, **fields: Any) -> None:
        if record is not None:
            fields = {**vars(record), **{k: v for k, v in fields.items() if v is not None}}
        severity = str(fields.get("severity_text") or "INFO")
        body = str(fields.get("body") or "")
        event_name = fields.get("event_name")
        attributes = dict(fields.get("attributes") or {})
        level = {"WARN": logging.WARNING, "FATAL": logging.CRITICAL}.get(
            severity, logging.getLevelName(severity)
        )
        logging.getLogger(self._name).log(
            level if isinstance(level, int) else logging.INFO,
            "%s: %s %s",
            event_name,
            body,
            json.dumps(attributes, separators=(",", ":"), default=str),
            extra={ECHO_MARKER: True},
        )
        if self.log_file is not None:
            self.log_file.write(
                severity_text=severity,
                event_name=event_name if isinstance(event_name, str) else None,
                body=body,
                attributes=attributes,
                scope=self._name,
                timestamp=fields.get("timestamp"),
            )


class DemoLoggerProvider(LoggerProvider):
    def __init__(self, log_file: DemoLogFile | None) -> None:
        self.log_file = log_file

    def get_logger(
        self,
        name: str,
        version: str | None = None,  # noqa: ARG002
        schema_url: str | None = None,  # noqa: ARG002
        attributes: Any = None,  # noqa: ARG002
    ) -> Logger:
        return DemoLogger(name, self.log_file)


def configure_logging(environment: Mapping[str, str] = os.environ) -> DemoLogFile | None:
    """Show the SDK's log events on the console and, when a log directory is set, in the file.

    The SDK writes its worker events only through the OpenTelemetry logs API. Without a logger
    provider they go nowhere, so this installs one that echoes each record to `logging` and writes
    it to the file.
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
        force=True,
    )
    log_file = demo_log_file(environment)
    if log_file is not None:
        logging.getLogger().addHandler(DemoLogHandler(log_file))
    set_logger_provider(DemoLoggerProvider(log_file))
    return log_file


def database_url(environment: Mapping[str, str] = os.environ) -> str:
    value = environment.get("DATABASE_URL_PRIMARY")
    if not value:
        raise RuntimeError("DATABASE_URL_PRIMARY is required")
    return value


def waits_for_schema(environment: Mapping[str, str] = os.environ) -> bool:
    """Only the development demo waits for a missing schema; production refuses at once."""
    mode = environment.get("WORKHORSE_DEMO_MODE") or "production"
    if mode not in ("development", "production"):
        raise RuntimeError("WORKHORSE_DEMO_MODE must be either development or production")
    return mode == "development"


def wait_for_schema(pool: ConnectionPool, retry_seconds: float = SCHEMA_RETRY_SECONDS) -> None:
    """Wait while the demo server has not installed the schema yet.

    In development the server installs the schema on first start, so a worker that starts beside
    it can see an empty database. Every other compatibility refusal fails at once.
    """
    logged = False
    while True:
        try:
            with pool.connection() as connection:
                assert_schema_compatible(connection)
            return
        except ProtocolCompatibilityError as error:
            if error.code != "schema-not-installed":
                raise
        if not logged:
            print("Waiting for the demo server to install the Workhorse schema", flush=True)
            logged = True
        time.sleep(retry_seconds)


def language_task(payload: Any, context: HandlerContext) -> dict[str, Json]:
    if not isinstance(payload, dict) or payload.get("language") != "python":
        raise ValueError("Python worker received a task for another language")
    return {"language": "python", "runtime": "python", "attempt": context.task.attempt}


def shared_task(payload: Any, context: HandlerContext) -> dict[str, Json]:
    if not isinstance(payload, dict) or not isinstance(payload.get("source"), str):
        raise ValueError("Shared worker requires a source")
    return {"source": payload["source"], "runtime": "python", "attempt": context.task.attempt}


def worker_id() -> str:
    hostname = "".join(
        character if character.isalnum() or character in ".-_" else "-"
        for character in socket.gethostname()
    )
    return f"demo-python-{hostname or 'unknown-host'}-{os.getpid()}-{str(uuid4())[:8]}"


def build_worker(pool: ConnectionPool, poll_ms: int) -> Worker:
    return (
        Worker(
            pool,
            queues=(PYTHON_QUEUE, SHARED_QUEUE, PYTHON_FAST_QUEUE),
            worker_id=worker_id(),
            concurrency=WORKER_CONCURRENCY,
            poll_ms=poll_ms,
            schedule_namespaces=(SCHEDULE_NAMESPACE, FAST_TIER_SCHEDULE_NAMESPACE),
            maintenance_interval_ms=1_000,
            registry_interval_ms=250,
        )
        .handle(LANGUAGE_TASK_TYPE, language_task)
        .handle(SHARED_TASK_TYPE, shared_task)
    )


def main() -> None:
    configure_logging()
    poll_ms = int(os.environ.get("WORKHORSE_WORKER_POLL_MS", DEFAULT_POLL_MS))
    with ConnectionPool(
        database_url(),
        min_size=WORKER_CONCURRENCY + 3,
        max_size=WORKER_CONCURRENCY + 3,
        kwargs={"autocommit": True},
    ) as pool:
        if waits_for_schema():
            wait_for_schema(pool)
        run_worker_process(build_worker(pool, poll_ms))


if __name__ == "__main__":
    main()
