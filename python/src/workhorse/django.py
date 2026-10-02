from __future__ import annotations

import inspect
import json
from collections.abc import Mapping, Sequence
from typing import Any, cast

import psycopg
from django.core.exceptions import ImproperlyConfigured
from django.db import connections
from django.db.transaction import TransactionManagementError
from django.tasks import Task, TaskResult, TaskResultStatus
from django.tasks.backends.base import BaseTaskBackend
from django.tasks.exceptions import InvalidTask
from django.utils import timezone
from django.utils.json import normalize_json
from django.utils.module_loading import import_string

from .client import Queue
from .types import EnqueueOptions, EnqueueResult, HandlerContext, Json
from .worker import Worker

__all__ = ["WorkhorseTaskBackend", "enqueue_in_atomic"]


def _validate_json_keys(value: Any) -> None:
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise TypeError("Task JSON objects must have string keys")
        for child in value.values():
            _validate_json_keys(child)
    elif isinstance(value, list):
        for child in value:
            _validate_json_keys(child)


def enqueue_in_atomic(
    task_type: str,
    payload: Json,
    *,
    using: str,
    options: EnqueueOptions | None = None,
) -> EnqueueResult:
    """Borrow the selected atomic block's connection for this enqueue only."""
    database = connections[using]
    database.validate_thread_sharing()
    if not database.in_atomic_block or database.get_autocommit():
        raise TransactionManagementError(
            "enqueue_in_atomic requires transaction.atomic(using=alias)"
        )
    connection = database.connection
    if not isinstance(connection, psycopg.Connection):
        raise TypeError("enqueue_in_atomic requires Django's PostgreSQL Psycopg 3 backend")
    if connection.closed or database.closed_in_transaction:
        raise TransactionManagementError("Django's atomic connection is closed")
    database.validate_no_broken_transaction()
    return Queue(connection).enqueue_with_result(task_type, payload, options)


class WorkhorseTaskBackend(BaseTaskBackend):
    """Atomic-only submission and allowlisted synchronous execution, without result lookup."""

    def __init__(self, alias: str, params: dict[str, Any]) -> None:
        queues = params.get("QUEUES", ["default"])
        if (
            not isinstance(queues, (list, tuple))
            or not queues
            or any(not isinstance(queue, str) or not queue for queue in queues)
        ):
            raise ImproperlyConfigured("QUEUES must be a nonempty list of queue names")
        super().__init__(alias, params)
        database_alias = self.options.get("DATABASE_ALIAS")
        paths = self.options.get("TASK_PATHS")
        attempts = self.options.get("MAX_ATTEMPTS", 25)
        if not isinstance(database_alias, str) or not database_alias:
            raise ImproperlyConfigured("Workhorse requires an explicit DATABASE_ALIAS")
        if (
            not isinstance(paths, (list, tuple))
            or not paths
            or any(not isinstance(path, str) or "." not in path for path in paths)
            or len(set(paths)) != len(paths)
        ):
            raise ImproperlyConfigured("TASK_PATHS must be a nonempty list of unique task paths")
        if isinstance(attempts, bool) or not isinstance(attempts, int) or not 1 <= attempts <= 100:
            raise ImproperlyConfigured("MAX_ATTEMPTS must be an integer between 1 and 100")
        self.database_alias = database_alias
        self.task_paths = tuple(paths)
        self.max_attempts = attempts
        self.task_type = f"django.tasks.{alias}"

    def validate_task(self, task: Task[Any, Any]) -> None:
        super().validate_task(task)
        if task.backend != self.alias:
            raise InvalidTask("Task backend does not match this Workhorse backend")
        if task.takes_context:
            raise InvalidTask("Workhorse does not supply Django TaskContext")
        if task.module_path not in self.task_paths:
            raise InvalidTask("Task path is not registered in TASK_PATHS")

    def _resolve(self, path: str) -> Task[Any, Any]:
        if path not in self.task_paths:
            raise InvalidTask("Task path is not registered in TASK_PATHS")
        registered = import_string(path)
        if not isinstance(registered, Task) or registered.module_path != path:
            raise InvalidTask("TASK_PATHS must resolve to decorated module-level Tasks")
        self.validate_task(registered.using(backend=self.alias, queue_name=sorted(self.queues)[0]))
        return registered

    def enqueue(
        self, task: Task[Any, Any], args: Sequence[Any], kwargs: Mapping[str, Any]
    ) -> TaskResult[Any, Any]:
        self.validate_task(task)
        registered = self._resolve(task.module_path)
        if registered.func is not task.func:
            raise InvalidTask("Task function differs from its registered decorated Task")
        normalized_args = cast(list[Any], normalize_json(list(args)))
        normalized_kwargs = cast(dict[str, Any], normalize_json(dict(kwargs)))
        if any(not isinstance(key, str) for key in normalized_kwargs):
            raise TypeError("Task keyword arguments must have string keys")
        inspect.signature(task.func).bind(*normalized_args, **normalized_kwargs)
        payload = {
            "version": 1,
            "backend": self.alias,
            "path": task.module_path,
            "queue": task.queue_name,
            "args": normalized_args,
            "kwargs": normalized_kwargs,
        }
        _validate_json_keys(payload)
        json.dumps(payload, allow_nan=False)
        accepted = enqueue_in_atomic(
            self.task_type,
            cast(Json, payload),
            using=self.database_alias,
            options=EnqueueOptions(queue=task.queue_name, max_attempts=self.max_attempts),
        )
        return TaskResult(
            task=task,
            id=accepted.task_id,
            status=TaskResultStatus.READY,
            enqueued_at=timezone.now(),
            started_at=None,
            finished_at=None,
            last_attempted_at=None,
            args=normalized_args,
            kwargs=normalized_kwargs,
            backend=self.alias,
            errors=[],
            worker_ids=[],
        )

    def bind_worker(self, worker: Worker) -> None:
        """Resolve trusted configuration at startup, never an import supplied by a payload."""
        registry = {path: self._resolve(path) for path in self.task_paths}

        def execute(payload: Any, context: HandlerContext) -> Json:
            if (
                not isinstance(payload, dict)
                or set(payload) != {"version", "backend", "path", "queue", "args", "kwargs"}
                or type(payload["version"]) is not int
                or payload["version"] != 1
                or payload["backend"] != self.alias
                or not isinstance(payload["path"], str)
                or payload["path"] not in registry
                or not isinstance(payload["queue"], str)
                or payload["queue"] not in self.queues
                or payload["queue"] != context.task.queue
                or not isinstance(payload["args"], list)
                or not isinstance(payload["kwargs"], dict)
                or any(not isinstance(key, str) for key in payload["kwargs"])
            ):
                raise InvalidTask("Invalid or unregistered Workhorse Django task envelope")
            _validate_json_keys(payload)
            json.dumps(payload, allow_nan=False)
            registered = registry[payload["path"]]
            inspect.signature(registered.func).bind(*payload["args"], **payload["kwargs"])
            returned = registered.func(*payload["args"], **payload["kwargs"])
            if inspect.isawaitable(returned):
                if inspect.iscoroutine(returned):
                    returned.close()
                raise InvalidTask("Workhorse does not execute coroutine task results")
            return None

        worker.handle(self.task_type, execute)
