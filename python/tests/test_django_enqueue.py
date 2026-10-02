from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import django
import psycopg
import pytest
from asgiref.sync import sync_to_async
from django.conf import settings
from django.db import connections, models, transaction
from django.db.transaction import TransactionManagementError
from django.db.utils import DatabaseError

from workhorse import EnqueueIdempotencyConflictError, EnqueueOptions, Idempotency, Queue

module_spec = importlib.util.spec_from_file_location(
    "django_enqueue", Path(__file__).parents[1] / "examples" / "django_enqueue.py"
)
assert module_spec is not None and module_spec.loader is not None
recipe = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(recipe)

pytestmark = pytest.mark.integration
ALIAS = "business"


@pytest.fixture(scope="session")
def business_model() -> type[models.Model]:
    if not settings.configured:
        settings.configure(DATABASES={"default": {}}, INSTALLED_APPS=[], USE_TZ=True)
    django.setup()

    class Order(models.Model):
        id = models.BigIntegerField(primary_key=True)
        note = models.TextField()

        class Meta:
            app_label = "django_recipe"
            db_table = "django_orders"

    return Order


@pytest.fixture
def django_database(database_url: str, business_model: type[models.Model]) -> Iterator[str]:
    parsed = urlsplit(database_url)
    configuration = {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": parsed.path.removeprefix("/"),
        "USER": parsed.username,
        "PASSWORD": parsed.password,
        "HOST": parsed.hostname,
        "PORT": parsed.port,
        "CONN_MAX_AGE": 0,
    }
    connections.databases[ALIAS] = connections.configure_settings(
        {"default": {}, ALIAS: configuration}
    )[ALIAS]
    database = connections[ALIAS]
    with database.schema_editor() as editor:
        editor.create_model(business_model)
    try:
        yield ALIAS
    finally:
        database.close()
        del connections[ALIAS]
        del connections.databases[ALIAS]


def visible_counts(database_url: str) -> tuple[int, int]:
    with psycopg.connect(database_url, autocommit=True) as observer:
        row = observer.execute(
            "SELECT (SELECT count(*) FROM django_orders), (SELECT count(*) FROM workhorse.task)"
        ).fetchone()
        assert row is not None
        return int(row[0]), int(row[1])


@pytest.mark.parametrize("enqueue_first", [False, True])
@pytest.mark.parametrize("rollback", [False, True])
def test_same_connection_and_joint_outcome(
    database_url: str,
    django_database: str,
    business_model: type[models.Model],
    monkeypatch: pytest.MonkeyPatch,
    enqueue_first: bool,
    rollback: bool,
) -> None:
    database = connections[django_database]
    borrowed: list[psycopg.Connection[Any]] = []

    def capture_queue(connection: psycopg.Connection[Any]) -> Queue:
        borrowed.append(connection)
        return Queue(connection)

    monkeypatch.setattr(recipe, "Queue", capture_queue)
    with transaction.atomic(using=django_database):
        raw = database.connection
        if enqueue_first:
            result = recipe.enqueue_in_atomic(
                "order.fulfill", {"order_id": 1}, using=django_database
            )
        business_model.objects.using(django_database).create(id=1, note="accepted")
        if not enqueue_first:
            result = recipe.enqueue_in_atomic(
                "order.fulfill", {"order_id": 1}, using=django_database
            )
        assert borrowed == [raw]
        with database.cursor() as cursor:
            cursor.execute("SELECT pg_backend_pid(), txid_current()")
            django_identity = cursor.fetchone()
        assert raw.execute("SELECT pg_backend_pid(), txid_current()").fetchone() == django_identity
        with psycopg.connect(database_url, autocommit=True) as observer:
            assert observer.info.backend_pid != raw.info.backend_pid
        assert result.outcome == "accepted"
        assert visible_counts(database_url) == (0, 0)
        if rollback:
            transaction.set_rollback(True, using=django_database)
    assert visible_counts(database_url) == ((0, 0) if rollback else (1, 1))
    assert not raw.closed


def test_savepoint_rollback_and_release_wait_for_outer_commit(
    database_url: str, django_database: str, business_model: type[models.Model]
) -> None:
    with transaction.atomic(using=django_database):
        business_model.objects.using(django_database).create(id=1, note="outer")
        recipe.enqueue_in_atomic("order.fulfill", {"order_id": 1}, using=django_database)
        with (
            pytest.raises(RuntimeError, match="inner rollback"),
            transaction.atomic(using=django_database),
        ):
            recipe.create_order(2, using=django_database)
            raise RuntimeError("inner rollback")
        recipe.create_order(3, using=django_database)
        assert visible_counts(database_url) == (0, 0)
        assert list(
            business_model.objects.using(django_database)
            .order_by("id")
            .values_list("id", flat=True)
        ) == [1, 3]
    assert visible_counts(database_url) == (2, 2)


def test_released_savepoint_is_rolled_back_with_outer_transaction(
    database_url: str, django_database: str
) -> None:
    with (
        pytest.raises(RuntimeError, match="outer rollback"),
        transaction.atomic(using=django_database),
    ):
        recipe.create_order(1, using=django_database)
        assert visible_counts(database_url) == (0, 0)
        raise RuntimeError("outer rollback")
    assert visible_counts(database_url) == (0, 0)


def test_no_driver_lifecycle_calls(
    database_url: str, django_database: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    with transaction.atomic(using=django_database):
        raw = connections[django_database].connection
        with monkeypatch.context() as guarded:

            def forbidden(*_args: object, **_kwargs: object) -> None:
                pytest.fail("enqueue touched the caller-owned connection lifecycle")

            for method in (
                "commit",
                "rollback",
                "close",
                "__enter__",
                "__exit__",
                "transaction",
                "set_autocommit",
                "set_isolation_level",
            ):
                guarded.setattr(type(raw), method, forbidden)
            guarded.setattr(psycopg, "connect", forbidden)
            guarded.setattr(connections[django_database], "connect", forbidden)
            guarded.setattr(transaction, "on_commit", forbidden)
            recipe.create_order(1, using=django_database)
        assert visible_counts(database_url) == (0, 0)
    assert visible_counts(database_url) == (1, 1)


@pytest.mark.parametrize("manual_transaction", [False, True])
def test_outside_atomic_is_rejected_even_with_autocommit_disabled(
    database_url: str, django_database: str, manual_transaction: bool
) -> None:
    database = connections[django_database]
    if manual_transaction:
        database.set_autocommit(False)
    try:
        with pytest.raises(TransactionManagementError, match=r"requires transaction\.atomic"):
            recipe.enqueue_in_atomic("order.fulfill", {}, using=django_database)
        assert visible_counts(database_url) == (0, 0)
    finally:
        if manual_transaction:
            database.rollback()
            database.set_autocommit(True)


def test_atomic_on_another_alias_does_not_authorize_enqueue(django_database: str) -> None:
    with (
        transaction.atomic(using=django_database),
        pytest.raises(TransactionManagementError, match=r"requires transaction\.atomic"),
    ):
        recipe.enqueue_in_atomic("order.fulfill", {}, using="default")


def test_unsupported_driver_is_rejected(
    django_database: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = connections[django_database]
    with transaction.atomic(using=django_database), monkeypatch.context() as guarded:
        guarded.setattr(database, "connection", object())
        with pytest.raises(TypeError, match="Psycopg 3"):
            recipe.enqueue_in_atomic("order.fulfill", {}, using=django_database)


def test_closed_atomic_connection_is_not_reopened(django_database: str) -> None:
    database = connections[django_database]
    with transaction.atomic(using=django_database):
        database.close()
        with pytest.raises(TransactionManagementError, match="closed"):
            recipe.enqueue_in_atomic("order.fulfill", {}, using=django_database)
    assert database.connection is None
    recipe.create_order(1, using=django_database)


def test_broken_django_transaction_is_rejected(django_database: str) -> None:
    with transaction.atomic(using=django_database):
        transaction.set_rollback(True, using=django_database)
        with pytest.raises(TransactionManagementError, match="error occurred"):
            recipe.enqueue_in_atomic("order.fulfill", {}, using=django_database)


def test_raw_database_error_escapes_atomic_and_connection_is_reusable(
    database_url: str, django_database: str
) -> None:
    database = connections[django_database]
    raw = database.connection

    raw.execute(
        "CREATE FUNCTION reject_django_task() RETURNS trigger LANGUAGE plpgsql AS $$ "
        "BEGIN RAISE EXCEPTION 'raw enqueue failure' USING ERRCODE = '22012'; END $$"
    )
    raw.execute(
        "CREATE TRIGGER reject_django_task BEFORE INSERT ON workhorse.task "
        "FOR EACH ROW EXECUTE FUNCTION reject_django_task()"
    )
    with pytest.raises(psycopg.errors.DivisionByZero) as failure:
        recipe.create_order(1, using=django_database)
    assert failure.value.sqlstate == "22012"
    assert visible_counts(database_url) == (0, 0)
    assert database.connection is raw and not raw.closed
    raw.execute("DROP TRIGGER reject_django_task ON workhorse.task")
    recipe.create_order(2, using=django_database)
    assert visible_counts(database_url) == (1, 1)


def test_structured_conflict_rolls_back_business_write(
    database_url: str, django_database: str, business_model: type[models.Model]
) -> None:
    options = EnqueueOptions(idempotency=Idempotency(key="same-order"))
    with transaction.atomic(using=django_database):
        created = recipe.enqueue_in_atomic(
            "order.fulfill", {"order_id": 1}, using=django_database, options=options
        )
        replayed = recipe.enqueue_in_atomic(
            "order.fulfill", {"order_id": 1}, using=django_database, options=options
        )
        assert replayed.task_id == created.task_id
        assert replayed.outcome == "replayed"
    with (
        pytest.raises(EnqueueIdempotencyConflictError) as failure,
        transaction.atomic(using=django_database),
    ):
        business_model.objects.using(django_database).create(id=2, note="rolled back")
        recipe.enqueue_in_atomic(
            "order.fulfill", {"order_id": 2}, using=django_database, options=options
        )
    assert failure.value.__cause__ is not None
    assert isinstance(failure.value.__cause__, psycopg.Error)
    assert failure.value.details["existingTaskId"] == created.task_id
    assert failure.value.details["scope"] == "default"
    assert failure.value.__cause__.sqlstate == "P1001"
    assert visible_counts(database_url) == (0, 1)
    recipe.create_order(3, using=django_database)
    assert visible_counts(database_url) == (1, 2)


def test_django_thread_ownership_is_checked_before_raw_access(
    django_database: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = connections[django_database]
    failures: list[Exception] = []

    def foreign_thread_enqueue() -> None:
        try:
            recipe.enqueue_in_atomic("order.fulfill", {}, using=django_database)
        except Exception as error:
            failures.append(error)

    with transaction.atomic(using=django_database), monkeypatch.context() as guarded:
        guarded.setattr(recipe, "connections", {django_database: database})
        thread = threading.Thread(target=foreign_thread_enqueue)
        thread.start()
        thread.join(timeout=5)
        assert not thread.is_alive()
    assert len(failures) == 1
    assert isinstance(failures[0], DatabaseError)
    assert "same thread" in str(failures[0])


def test_request_close_and_reopen_does_not_reuse_old_queue(
    database_url: str, django_database: str
) -> None:
    database = connections[django_database]
    recipe.create_order(1, using=django_database)
    first = database.connection
    database.close()
    assert first.closed
    recipe.create_order(2, using=django_database)
    assert database.connection is not first
    assert visible_counts(database_url) == (2, 2)


@pytest.mark.asyncio
@pytest.mark.parametrize("rollback", [False, True])
async def test_async_wraps_whole_transaction_on_one_thread(
    database_url: str, django_database: str, monkeypatch: pytest.MonkeyPatch, rollback: bool
) -> None:
    event_loop_thread = threading.get_ident()
    sync_create_order = recipe.create_order
    observations: list[tuple[int, bool, tuple[int, int]]] = []

    def observed_create_order(order_id: int, *, using: str) -> Any:
        database = connections[using]
        try:
            with transaction.atomic(using=using):
                result = sync_create_order(order_id, using=using)
                observations.append(
                    (threading.get_ident(), database.in_atomic_block, visible_counts(database_url))
                )
                if rollback:
                    raise RuntimeError("async business rollback")
                return result
        finally:
            database.close()
            del connections[using]

    monkeypatch.setattr(recipe, "create_order", observed_create_order)
    if rollback:
        with pytest.raises(RuntimeError, match="async business rollback"):
            await recipe.create_order_async(1, using=django_database)
    else:
        result = await recipe.create_order_async(1, using=django_database)
        assert result.outcome == "accepted"
    assert observations[0][0] != event_loop_thread
    assert observations[0][1:] == (True, (0, 0))
    assert await sync_to_async(visible_counts, thread_sensitive=True)(database_url) == (
        (0, 0) if rollback else (1, 1)
    )


def test_runnable_alias_explicit_example(
    database_url: str, django_database: str, tmp_path: Path
) -> None:
    configuration = dict(connections.databases[django_database])
    settings_file = tmp_path / "recipe_settings.py"
    settings_file.write_text(
        f"DATABASES = {{'default': {{}}, {django_database!r}: {configuration!r}}}\n"
        "INSTALLED_APPS = []\nUSE_TZ = True\n"
    )
    environment = os.environ.copy()
    environment["DJANGO_SETTINGS_MODULE"] = "recipe_settings"
    environment["PYTHONPATH"] = str(tmp_path)
    completed = subprocess.run(
        [sys.executable, str(Path(recipe.__file__)), "--using", django_database, "--order-id", "1"],
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )
    assert len(completed.stdout.strip()) == 36
    assert visible_counts(database_url) == (1, 1)
