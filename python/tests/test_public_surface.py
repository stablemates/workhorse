"""The import surface of every public module in the package.

A module without a leading underscore is a documented import path, so its namespace is a
promise. These tests pin that promise: each such module declares `__all__`, and nothing a
private module owns can be reached through it.
"""

from __future__ import annotations

import ast
import importlib
import re
from pathlib import Path
from types import ModuleType

import pytest

import workhorse

PACKAGE = Path(workhorse.__file__).parent
REPOSITORY = PACKAGE.parents[2]


def _public_module_names() -> list[str]:
    names = {"workhorse"}
    for path in sorted(PACKAGE.rglob("*.py")):
        parts = path.relative_to(PACKAGE).with_suffix("").parts
        if parts[-1] == "__init__":
            parts = parts[:-1]
        if any(part.startswith("_") for part in parts):
            continue
        names.add(".".join(("workhorse", *parts)))
    return sorted(names)


PUBLIC_MODULES = _public_module_names()


def _export_order(name: str) -> tuple[int, str]:
    """Ruff's RUF022 order: SCREAMING_SNAKE_CASE, then CamelCase, then snake_case."""
    return (0 if name.isupper() else 1 if name[0].isupper() else 2, name)


def _source(module: ModuleType) -> str:
    return Path(module.__file__ or "").read_text()


def _module_level_bindings(tree: ast.Module) -> list[tuple[str, str | None]]:
    """Every name the module binds at module level, with the module it was imported from."""
    bindings: list[tuple[str, str | None]] = []

    def record(node: ast.stmt) -> None:
        if isinstance(node, ast.Import):
            for alias in node.names:
                bindings.append((alias.asname or alias.name.split(".")[0], alias.name))
        elif isinstance(node, ast.ImportFrom):
            source = "." * node.level + (node.module or "")
            for alias in node.names:
                bindings.append((alias.asname or alias.name, source))
        elif isinstance(node, ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef):
            bindings.append((node.name, None))
        elif isinstance(node, ast.TypeAlias):
            bindings.append((node.name.id, None))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            bindings.append((node.target.id, None))
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    bindings.append((target.id, None))
        elif isinstance(node, ast.If):
            for branch in [*node.body, *node.orelse]:
                record(branch)

    for node in tree.body:
        record(node)
    return bindings


def _workhorse_submodule(source: str) -> str | None:
    """The path under `workhorse` that `source` names, or None when it names another package."""
    if source.startswith("."):
        return source.lstrip(".")
    if source == "workhorse":
        return ""
    if source.startswith("workhorse."):
        return source.removeprefix("workhorse.")
    return None


def _reexports_a_public_name(source: str, name: str) -> bool:
    """True when `source` is another public workhorse module that exports `name` itself."""
    relative = _workhorse_submodule(source)
    if not relative or any(part.startswith("_") for part in relative.split(".")):
        return False
    return name in getattr(importlib.import_module(f"workhorse.{relative}"), "__all__", ())


@pytest.mark.parametrize("module_name", PUBLIC_MODULES)
def test_public_module_declares_a_sorted_all(module_name: str) -> None:
    module = importlib.import_module(module_name)
    exported = getattr(module, "__all__", None)

    assert isinstance(exported, list), f"{module_name} declares no __all__"
    assert all(isinstance(name, str) for name in exported)
    assert len(set(exported)) == len(exported), f"{module_name}.__all__ repeats a name"
    assert exported == sorted(exported, key=_export_order), f"{module_name}.__all__ is out of order"
    missing = [name for name in exported if not hasattr(module, name)]
    assert not missing, f"{module_name}.__all__ names {missing}, which it does not define"


@pytest.mark.parametrize("module_name", PUBLIC_MODULES)
def test_public_module_leaks_no_private_name(module_name: str) -> None:
    module = importlib.import_module(module_name)
    exported = set(module.__all__)
    tree = ast.parse(_source(module))

    leaked = [
        name
        for name, source in _module_level_bindings(tree)
        if not name.startswith("_")
        and name not in exported
        and (source is None or _workhorse_submodule(source) is not None)
        and not (source and _reexports_a_public_name(source, name))
    ]
    assert not leaked, (
        f"{module_name} exposes {sorted(set(leaked))} outside __all__; "
        "prefix the name with an underscore or export it deliberately"
    )


@pytest.mark.parametrize("module_name", PUBLIC_MODULES)
def test_public_module_exposes_nothing_beyond_all_and_imports(module_name: str) -> None:
    module = importlib.import_module(module_name)
    tree = ast.parse(_source(module))
    imported = {name for name, source in _module_level_bindings(tree) if source is not None}

    surface = {
        name
        for name in dir(module)
        if not name.startswith("_")
        and name not in module.__all__
        and name not in imported
        and not isinstance(getattr(module, name), ModuleType)
    }
    assert not surface, f"{module_name} defines {sorted(surface)} outside __all__"


def test_documented_python_imports_resolve() -> None:
    sources = [
        *sorted((REPOSITORY / "docs" / "guides").glob("*.md")),
        *sorted((REPOSITORY / "site" / "content" / "docs").glob("*.mdx")),
        REPOSITORY / "python" / "README.md",
    ]
    statements: list[tuple[Path, str]] = []
    for source in sources:
        text = source.read_text()
        for indent, block in re.findall(
            r"^([ \t]*)```python\n(.*?)^\1```", text, re.DOTALL | re.MULTILINE
        ):
            dedented = re.sub(rf"^{indent}", "", block, flags=re.MULTILINE)
            for statement in re.findall(
                r"^(from workhorse[\w.]* import \([^)]*\)|from workhorse[\w.]* import [^\n]+"
                r"|import workhorse[\w.]*)$",
                dedented,
                re.MULTILINE,
            ):
                statements.append((source, statement))

    assert statements, "no documented Python import lines were found"
    for source, statement in statements:
        try:
            exec(compile(statement, str(source), "exec"), {})
        except ImportError as error:  # pragma: no cover - the assertion carries the detail
            pytest.fail(f"{source.relative_to(REPOSITORY)}: {statement!r} does not import: {error}")
