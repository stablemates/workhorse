"""The API snapshot records the attributes that a public ``__init__`` assigns.

``python/tools/api_snapshot.py`` writes ``api/python.txt``. A caller reads ``error.code`` or
``error.retry_after_ms`` the same way as a method, so a removed or retyped attribute must change a
line of the snapshot, and a new attribute must only add one (SM-2047).
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import pytest

REPOSITORY = Path(__file__).resolve().parents[2]

ORIGINAL = """
class RateLimited(Exception):
    def __init__(self, task_id: str, retry_after_ms: int) -> None:
        self.task_id = task_id
        self.retry_after_ms = retry_after_ms
        self.state = str(task_id)
        if retry_after_ms > 0:
            self.delayed: bool = True
        self._private = 1
        super().__init__(task_id)
"""


def _tool() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "api_snapshot_under_test", REPOSITORY / "python" / "tools" / "api_snapshot.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def members(tmp_path: Path) -> Iterator[object]:
    """Render the members of one class, ``RateLimited`` by default, as a source text defines it."""
    tool = _tool()
    sys.path.insert(0, str(tmp_path))
    counter = iter(range(1000))

    def render(source: str, class_name: str = "RateLimited") -> list[str]:
        # The tool reads only bases whose module is part of `workhorse`, so the fixture module
        # takes a name with that prefix. Each call loads a new module, so no source is cached.
        name = f"workhorse_snapshot_fixture_{next(counter)}"
        (tmp_path / f"{name}.py").write_text(source, encoding="utf8")
        # The import system caches the files of each folder and refreshes the cache when the
        # folder's time changes. Two files written in one tick of a coarse file system clock
        # leave the folder's time as it was, so the cache is cleared before each import.
        importlib.invalidate_caches()
        module = importlib.import_module(name)
        return tool.Renderer().members(getattr(module, class_name))

    yield render
    sys.path.remove(str(tmp_path))
    for name in [name for name in sys.modules if name.startswith("workhorse_snapshot_fixture_")]:
        del sys.modules[name]


def test_records_each_public_attribute_with_its_type(members) -> None:
    lines = members(ORIGINAL)

    assert "  task_id: str  # set by __init__" in lines
    assert "  retry_after_ms: int  # set by __init__" in lines
    assert "  state: str  # set by __init__" in lines
    assert "  delayed: bool  # set by __init__" in lines
    assert not any("_private" in line for line in lines)


def test_a_removed_or_retyped_attribute_removes_a_line(members) -> None:
    before = members(ORIGINAL)
    renamed = members(ORIGINAL.replace("self.retry_after_ms =", "self.retry_after =", 1))
    retyped = members(ORIGINAL.replace("retry_after_ms: int)", "retry_after_ms: float)", 1))

    assert "  retry_after_ms: int  # set by __init__" not in renamed
    assert "  retry_after_ms: int  # set by __init__" not in retyped
    assert set(before) - set(renamed)
    assert set(before) - set(retyped)


def test_a_new_attribute_only_adds_a_line(members) -> None:
    before = members(ORIGINAL)
    added = members(
        ORIGINAL.replace(
            "        self._private = 1", "        self._private = 1\n        self.code = 'x'"
        )
    )

    assert set(before) <= set(added)
    assert set(added) - set(before) == {"  code: str  # set by __init__"}


def test_an_attribute_of_a_nested_function_is_not_recorded(members) -> None:
    lines = members(
        ORIGINAL.replace(
            "        self._private = 1",
            "        self._private = 1\n\n"
            "        def later() -> None:\n"
            "            self.hidden = 1\n",
        )
    )

    assert not any("hidden" in line for line in lines)


CHAIN = """
class Base(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)


class Conflict(Base):
    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(task_id)


class InputConflict(Conflict):
    def __init__(self, task_id: str, name: str) -> None:
        Base.__init__(self, name)
        self.task_id = task_id
        self.name = name


class Plain(Conflict):
    def __init__(self, task_id: str) -> None:
        super().__init__(task_id)
"""


def test_reads_only_the_initializers_that_construction_runs(members) -> None:
    skipping = members(CHAIN, "InputConflict")
    removed = members(
        CHAIN.replace("        self.task_id = task_id\n        self.name", "        self.name"),
        "InputConflict",
    )

    # `InputConflict` calls `Base.__init__`, so the assignment in `Conflict.__init__` never runs.
    assert "  task_id: str  # set by __init__" in skipping
    assert "  task_id: str  # set by __init__" not in removed
    # `Plain` reaches `Conflict.__init__` through `super()`, so its attribute is present.
    assert "  task_id: str  # set by __init__" in members(CHAIN, "Plain")


ORDERED = """
class _Base(Exception):
    def __init__(self) -> None:
        self.code = "x"
        super().__init__()


class Coded(_Base):
    def __init__(self) -> None:
        self.code = 1
        super().__init__()
"""


def test_states_the_type_of_the_last_assignment_that_runs(members) -> None:
    # `Coded` assigns `1`, then its base assigns `"x"`, so the instance keeps a `str`.
    assert "  code: str  # set by __init__" in members(ORDERED, "Coded")
    # A base call before the assignment leaves the `int` of the subclass.
    reordered = ORDERED.replace(
        "        self.code = 1\n        super().__init__()",
        "        super().__init__()\n        self.code = 1",
    )
    assert "  code: int  # set by __init__" in members(reordered, "Coded")


def test_states_each_type_of_an_assignment_in_a_branch(members) -> None:
    branched = ORDERED.replace(
        "        self.code = 1\n        super().__init__()",
        "        super().__init__()\n        if self.args:\n            self.code = 1",
    )
    assert "  code: int | str  # set by __init__" in members(branched, "Coded")


def test_leaves_an_attribute_that_the_class_declares_to_its_annotation(members) -> None:
    declared = """
class RateLimited(Exception):
    code: str

    def __init__(self) -> None:
        self.code = 0
        self.code = "ready"
"""
    lines = members(declared)
    assert "  code: str" in lines
    assert not any("set by __init__" in line for line in lines)


CAST = """
from typing import cast


class RateLimited(Exception):
    def __init__(self, details: dict[str, object]) -> None:
        self.limit = cast(int, details["limit"])
"""


def test_reads_the_type_of_a_cast(members) -> None:
    before = members(CAST)
    after = members(CAST.replace("cast(int,", "cast(str,"))

    assert "  limit: int  # set by __init__" in before
    assert "  limit: int  # set by __init__" not in after


def test_reads_a_quoted_annotation_as_the_annotation(members) -> None:
    quoted = CAST.replace('self.limit = cast(int, details["limit"])', 'self.limit: "int" = 1')
    plain = CAST.replace('self.limit = cast(int, details["limit"])', "self.limit: int = 1")
    assert members(quoted) == members(plain)
    assert "  limit: int  # set by __init__" in members(quoted)
