"""Framework-neutral WSGI host for the embedded Workhorse dashboard."""

from __future__ import annotations

import dis
import importlib.resources
import json
import logging
import mimetypes
import tarfile
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from html import escape
from http import HTTPStatus
from io import BytesIO
from pathlib import Path
from threading import Lock
from typing import Any, Protocol, cast
from urllib.parse import urlsplit

from .._compatibility import assert_sync_compatible as _assert_sync_compatible
from .._drivers import PsycopgConnection as _PsycopgConnection, SyncExecutor as _SyncExecutor
from .._version import WORKHORSE_VERSION as _WORKHORSE_VERSION
from ..dashboard_v1 import (
    _INPUT_SCHEMAS,
    DashboardInputValidationError,
    _validate_schema,
    validate_input,
)
from ..errors import ProtocolCompatibilityError as _ProtocolCompatibilityError
from ._backend import (
    DASHBOARD_STATEMENT_TIMEOUT_MS as _DASHBOARD_STATEMENT_TIMEOUT_MS,
    DashboardBackend as _DashboardBackend,
)
from ._errors import DashboardRPCError as _DashboardRPCError

_MUTATIONS = frozenset(
    {
        "enqueueTest",
        "setSchedulePaused",
        "setQueuePaused",
        "purgeQueue",
        "setQueueTier",
        "setQueueHistory",
        "setWorkerPaused",
        "overrideMaintenancePolicy",
        "revertMaintenancePolicy",
        "overrideRetentionPolicy",
        "revertRetentionPolicy",
        "runTaskNow",
        "cancelTask",
        "signalTask",
        "completeHumanWait",
        "redriveTask",
        "redriveDeadLetters",
        "cancelTaskGroup",
    }
)
_OPTIONAL_MUTATIONS = frozenset({"enqueueTest", "setSchedulePaused"})
# The largest RPC request body the host reads, the same bound the Go and Rust hosts apply.
_MAX_REQUEST_BYTES = 2 << 20
# Characters escaped in the runtime configuration so it cannot close its inline script.
# ``json.dumps`` already escapes every non-ASCII character, including U+2028 and U+2029.
_SCRIPT_ESCAPES = {ord("<"): "\\u003c", ord(">"): "\\u003e", ord("&"): "\\u0026"}
# The audit request ID bound of the SQL audit functions, in UTF-8 bytes. JSON Schema measures
# strings in characters, so the generated validator cannot state this bound.
_MAX_REQUEST_ID_BYTES = 512
_UNVERIFIED_COMPATIBILITY = (
    "Unable to verify Workhorse schema compatibility because the database query failed."
)
_LOGGER = logging.getLogger("workhorse.dashboard")
_CONTENT_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
}


@dataclass(frozen=True)
class DashboardPrincipal:
    """Identity established by the embedding application's authorization boundary."""

    actor: str


@dataclass(frozen=True)
class DashboardResponse:
    status: int
    body: bytes
    headers: tuple[tuple[str, str], ...] = ()


class DashboardProcedure(Protocol):
    def __call__(self, input: object, actor: str) -> object: ...


Authorize = Callable[[dict[str, object]], DashboardPrincipal | bool | DashboardResponse]


class _ApplicationProcedureError(Exception):
    """A ``ValueError`` from an application procedure, which gets the fixed 500 answer."""


def _application_procedure(handler: DashboardProcedure) -> DashboardProcedure:
    """Give a ``ValueError`` from application code the fixed 500 answer.

    The host answers its own input errors, which are ``ValueError`` subclasses, with their
    message. The message of an application exception can name a path or a database address, so
    it stays in the log.
    """

    def call(input: object, actor: str) -> object:
        try:
            return handler(input, actor)
        except ValueError as error:
            raise _ApplicationProcedureError(type(error).__name__) from error

    return call


# The directory of the ``workhorse`` package. A ``ValueError`` that code in it raises carries a
# message that Workhorse wrote.
_PACKAGE_ROOT = Path(__file__).resolve().parent.parent


_RAISE = dis.opmap["RAISE_VARARGS"]


def _raised_by_workhorse(error: BaseException) -> bool:
    """Whether a ``raise`` statement of the ``workhorse`` package raised ``error``.

    A function of the runtime, such as ``int``, adds no frame of its own, so its error ends in the
    frame of its caller. That frame then runs a call, not a ``raise`` statement.
    """
    traceback = error.__traceback__
    if traceback is None:
        return False
    while traceback.tb_next is not None:
        traceback = traceback.tb_next
    code = traceback.tb_frame.f_code
    return (
        Path(code.co_filename).resolve().is_relative_to(_PACKAGE_ROOT)
        and code.co_code[traceback.tb_lasti] == _RAISE
    )


def _declared_only(procedure: str, value: object) -> object:
    """Return a valid input without the object keys that its request schema does not declare.

    The TypeScript host's schema parse drops these keys. Each SQL procedure reads its input
    document by key, so an undeclared key, such as a health document in a system read, must not
    reach SQL. An object schema with ``additionalProperties``, such as a signal payload, is free
    JSON and keeps every key.
    """
    schema = _INPUT_SCHEMAS.get(procedure)
    return value if not isinstance(schema, dict) else _declared(schema, schema, value)


def _declared(schema: dict[str, Any], root: dict[str, Any], value: object) -> object:
    reference = schema.get("$ref")
    if isinstance(reference, str):
        resolved = root.get("$defs", {}).get(reference.removeprefix("#/$defs/"))
        return _declared(resolved, root, value) if isinstance(resolved, dict) else value
    branches = schema.get("anyOf")
    if isinstance(branches, list):
        # The first branch that accepts the value owns it, as in the validator.
        for branch in branches:
            try:
                _validate_schema(branch, root, value, "$")
            except DashboardInputValidationError:
                continue
            return _declared(branch, root, value)
        return value
    if isinstance(value, dict):
        additional = schema.get("additionalProperties")
        if isinstance(additional, dict):
            return {name: _declared(additional, root, child) for name, child in value.items()}
        properties = schema.get("properties")
        if not isinstance(properties, dict):
            return value
        return {
            name: _declared(properties[name], root, child)
            for name, child in value.items()
            if isinstance(properties.get(name), dict)
        }
    items = schema.get("items")
    if isinstance(value, list) and isinstance(items, dict):
        return [_declared(items, root, item) for item in value]
    return value


def _oversized_request_id(input_value: object) -> bool:
    if not isinstance(input_value, dict):
        return False
    audit = input_value.get("audit")
    if not isinstance(audit, dict):
        return False
    request_id = audit.get("requestId")
    return (
        isinstance(request_id, str)
        and len(request_id.encode("utf-8", "surrogatepass")) > _MAX_REQUEST_ID_BYTES
    )


def _normalize_dashboard_path(path: str) -> str:
    normalized = "/" + "/".join(part for part in path.split("/") if part)
    return "" if normalized == "/" else normalized


def _canonical_host(host: str, scheme: str) -> str:
    """Lowercase a host[:port] and drop the default port, so one address has one spelling."""
    host = host.lower()
    default = {"http": ":80", "https": ":443"}.get(scheme)
    if default is not None and host.endswith(default):
        host = host[: -len(default)]
    return f"{scheme}://{host}"


def _allowed_hosts(entries: tuple[str, ...]) -> frozenset[str]:
    allowed: set[str] = set()
    for entry in entries:
        parsed = urlsplit("http://" + entry)
        if parsed.netloc != entry or parsed.path or parsed.query or parsed.fragment or "@" in entry:
            raise ValueError(f"dashboard allowed host must be a bare host[:port]: {entry!r}")
        allowed.add(_canonical_host(entry, "http"))
        allowed.add(_canonical_host(entry, "https"))
    return frozenset(allowed)


class DashboardHost:
    """A WSGI application serving one embedded dashboard and its RPC contract.

    ``allowed_hosts`` lists the ``host[:port]`` values the dashboard answers to. When set, a
    request under ``path`` whose ``Host`` is not listed receives 421 Misdirected Request before
    ``authorize`` runs. Letter case and a default port do not matter. Leave it empty when the
    embedding application already validates ``Host``.

    ``statement_timeout_ms`` bounds each dashboard read. The host runs each read in its own
    read-only transaction, and PostgreSQL cancels a read that runs longer. The procedure then
    answers the ``TIMEOUT`` RPC error with status 408. The default is 15,000 ms. The bound applies
    only when the host owns the transaction, which is when psycopg reports the connection idle.
    If the connection is inside a transaction of the caller when a read starts, or its state is not
    reported, the read runs directly with no bound, and the host commits nothing and rolls nothing
    back. The host runs one procedure at a time on the
    connection, and no other code may use the connection while a request runs.

    ``redact_error_stacks`` removes the stack of each worker error from task detail, the event
    feed, and event detail, also from ``details.error`` of a ``failed`` or ``retry_scheduled``
    event. The event search then does not match a withheld stack. A request cannot change it. The
    default ``False`` returns each error as stored.
    """

    def __init__(
        self,
        connection: object,
        *,
        authorize: Authorize,
        path: str = "/workhorse",
        environment: str = "development",
        audit_actor: str | None = None,
        read_only: bool = False,
        browser_modules: tuple[str, ...] = (),
        configured_workers: tuple[str, ...] = (),
        maintenance_loops: Mapping[str, int] | None = None,
        enqueue_test: DashboardProcedure | None = None,
        set_schedule_paused: DashboardProcedure | None = None,
        allowed_hosts: tuple[str, ...] = (),
        statement_timeout_ms: int = _DASHBOARD_STATEMENT_TIMEOUT_MS,
        redact_error_stacks: bool = False,
        _procedures: Mapping[str, DashboardProcedure] | None = None,
        _skip_compatibility_check: bool = False,
    ) -> None:
        if getattr(connection, "autocommit", None) is not True:
            raise ValueError("dashboard connection must use autocommit=True")
        if (
            isinstance(statement_timeout_ms, bool)
            or not isinstance(statement_timeout_ms, int)
            or statement_timeout_ms < 1
        ):
            raise ValueError("dashboard statement_timeout_ms must be a positive integer")
        self.base_path = _normalize_dashboard_path(path)
        self._allowed_hosts = _allowed_hosts(allowed_hosts)
        self._authorize = authorize
        self._environment = environment
        self._audit_actor = audit_actor
        self._read_only = read_only
        self._browser_modules = browser_modules
        self._executor = _SyncExecutor(cast(_PsycopgConnection, connection))
        backend = _DashboardBackend(
            self._executor,
            environment=environment,
            configured_workers=configured_workers,
            maintenance_loops=maintenance_loops or {"tickIntervalMs": 1_000},
            read_only=read_only,
            statement_timeout_ms=statement_timeout_ms,
            redact_error_stacks=redact_error_stacks,
        )
        # A read runs as several statements in one transaction on the shared connection. The
        # host runs one procedure at a time, so a statement of another request cannot run inside
        # that transaction.
        self._connection_lock = Lock()
        extensions = dict(_procedures or {})
        if enqueue_test is not None:
            extensions["enqueueTest"] = enqueue_test
        if set_schedule_paused is not None:
            extensions["setSchedulePaused"] = set_schedule_paused
        self._procedures = {
            **backend.procedures(),
            **{name: _application_procedure(handler) for name, handler in extensions.items()},
        }
        self._skip_compatibility_check = _skip_compatibility_check
        self._compatible = False
        self._compatibility_lock = Lock()
        self._assets: dict[str, bytes] | None = None
        self._assets_lock = Lock()

    def __call__(
        self,
        environ: dict[str, object],
        start_response: Callable[[str, list[tuple[str, str]]], object],
    ) -> Iterable[bytes]:
        response = self.handle(environ)
        headers = list(response.headers)
        if not any(name.lower() == "content-length" for name, _value in headers):
            headers.append(("Content-Length", str(len(response.body))))
        try:
            phrase = HTTPStatus(response.status).phrase
        except ValueError:
            phrase = "Unknown Status"
        start_response(f"{response.status} {phrase}", headers)
        return [response.body]

    def owns(self, path: str) -> bool:
        return path == self.base_path or path.startswith(self.base_path + "/")

    def handle(self, environ: dict[str, object]) -> DashboardResponse:
        path = str(environ.get("PATH_INFO", ""))
        if not self.owns(path):
            return self._json(404, {"error": "Not Found"})
        # A name the dashboard does not answer to may resolve to this listener, so its requests
        # are refused before any credential or session is consulted.
        if self._allowed_hosts and (
            _canonical_host(
                str(environ.get("HTTP_HOST", "")), str(environ.get("wsgi.url_scheme", "http"))
            )
            not in self._allowed_hosts
        ):
            return self._json(421, {"error": "Misdirected Request"})
        authorization = self._authorize(environ)
        if isinstance(authorization, DashboardResponse):
            return authorization
        if authorization is False:
            return self._json(401, {"error": "Unauthorized"})
        # A verified principal names the actor; the audit actor stands in only for a bare True.
        actor = (self._audit_actor or "dashboard") if authorization is True else authorization.actor
        try:
            self._assert_compatible()
        except _ProtocolCompatibilityError as error:
            return self._json(503, {"error": str(error)})
        except Exception:
            # A driver error can name the database host, user, or path, so it stays in the log.
            _LOGGER.exception("Dashboard schema compatibility check failed")
            return self._json(503, {"error": _UNVERIFIED_COMPATIBILITY})

        rpc_prefix = self.base_path + "/rpc/dashboard/"
        if not path.startswith(rpc_prefix) and self._cross_origin_read(environ):
            return self._json(403, {"error": "A same-origin request is required"})
        mount_root = self.base_path or "/"
        if path == mount_root:
            return DashboardResponse(302, b"", (("Location", self.base_path + "/tasks"),))
        asset_prefix = self.base_path + "/assets/"
        if path.startswith(asset_prefix):
            return self._asset(path[len(self.base_path) + 1 :])
        if path.startswith(rpc_prefix):
            return self._rpc(environ, path[len(rpc_prefix) :], actor)
        return self._application(actor)

    def _assert_compatible(self) -> None:
        if self._skip_compatibility_check or self._compatible:
            return
        with self._compatibility_lock:
            if not self._compatible:
                with self._connection_lock:
                    _assert_sync_compatible(self._executor)
                self._compatible = True

    def _rpc(self, environ: dict[str, object], procedure: str, actor: str) -> DashboardResponse:
        if str(environ.get("REQUEST_METHOD", "GET")) != "POST":
            return self._rpc_error(405, "METHOD_NOT_SUPPORTED", "Method Not Supported")
        if procedure not in _MUTATIONS and self._cross_origin_read(environ):
            return self._json(403, {"error": "A same-origin request is required"})
        if procedure in _MUTATIONS:
            if not self._same_origin(environ):
                return self._json(403, {"error": "A same-origin mutation request is required"})
            if self._read_only:
                return self._rpc_error(403, "FORBIDDEN", "This dashboard is read-only")
        handler = self._procedures.get(procedure)
        if handler is None:
            if procedure in _OPTIONAL_MUTATIONS:
                return self._rpc_error(
                    403, "FORBIDDEN", f"This dashboard host does not provide the {procedure} action"
                )
            return self._rpc_error(404, "NOT_FOUND", "Procedure not found")
        body = self._read_body(environ)
        if body is None:
            return self._rpc_error(413, "PAYLOAD_TOO_LARGE", "Payload Too Large")
        input_value: object = None
        calling = False
        try:
            envelope = json.loads(body or b"{}")
            if not isinstance(envelope, dict):
                raise DashboardInputValidationError("request envelope must be an object")
            input_value = envelope.get("json")
            validate_input(procedure, input_value)
            input_value = _declared_only(procedure, input_value)
            if (
                procedure == "enqueueTest"
                and isinstance(input_value, dict)
                and input_value.get("kind") == "feature"
                and "feature" not in input_value
            ):
                raise _DashboardRPCError(
                    400,
                    "BAD_REQUEST",
                    "Input validation failed",
                    {
                        "issues": [
                            {
                                "code": "custom",
                                "path": ["feature"],
                                "message": "The feature demo kind requires a feature family",
                            }
                        ]
                    },
                )
            if procedure in _MUTATIONS and _oversized_request_id(input_value):
                raise _DashboardRPCError(
                    400,
                    "BAD_REQUEST",
                    "Input validation failed",
                    {
                        "issues": [
                            {
                                "code": "custom",
                                "path": ["audit", "requestId"],
                                "message": "The request ID must contain at most 512 UTF-8 bytes",
                            }
                        ]
                    },
                )
            if isinstance(input_value, dict) and isinstance(input_value.get("audit"), dict):
                input_value = dict(input_value)
                input_value["audit"] = {**input_value["audit"], "actor": actor}
            calling = True
            with self._connection_lock:
                result = handler(input_value, actor)
        except DashboardInputValidationError as error:
            if (
                procedure == "tasks"
                and isinstance(input_value, dict)
                and isinstance(input_value.get("page"), int)
                and input_value["page"] < 1
            ):
                return self._rpc_error(
                    400,
                    "BAD_REQUEST",
                    "Input validation failed",
                    {
                        "issues": [
                            {
                                "origin": "number",
                                "code": "too_small",
                                "minimum": 1,
                                "inclusive": True,
                                "path": ["page"],
                                "message": "Too small: expected number to be >=1",
                            }
                        ]
                    },
                )
            return self._rpc_error(400, "BAD_REQUEST", str(error))
        except (json.JSONDecodeError, ValueError) as error:
            # A refused input keeps its message only when the host or Workhorse wrote it. A driver
            # or a library can put a stored value or an address in its message.
            if calling and not _raised_by_workhorse(error):
                _LOGGER.error("workhorse dashboard: procedure %s failed", procedure, exc_info=error)
                return self._rpc_error(500, "INTERNAL_SERVER_ERROR", "Internal server error")
            return self._rpc_error(400, "BAD_REQUEST", str(error))
        except _DashboardRPCError as error:
            return self._rpc_error(error.status, error.code, error.message, error.data)
        except Exception:
            # The exception text can name a path or a database address, so it stays in the log.
            _LOGGER.exception("workhorse dashboard: procedure %s failed", procedure)
            return self._rpc_error(500, "INTERNAL_SERVER_ERROR", "Internal server error")
        return self._json(200, {} if result is None else {"json": result})

    @staticmethod
    def _read_body(environ: dict[str, object]) -> bytes | None:
        """Read at most ``_MAX_REQUEST_BYTES``, or return None for a body that is larger."""
        declared = str(environ.get("CONTENT_LENGTH", "") or "")
        stream = cast(Any, environ["wsgi.input"])
        if declared:
            # A length too long to parse is too large; the check also keeps int() within its limit.
            if len(declared) > 20 or not declared.isascii() or not declared.isdigit():
                return None
            length = int(declared)
            if length > _MAX_REQUEST_BYTES:
                return None
            return cast(bytes, stream.read(length))
        # Without a declared length WSGI defines the stream's end only when the server marks it.
        if not environ.get("wsgi.input_terminated"):
            return b""
        body = cast(bytes, stream.read(_MAX_REQUEST_BYTES + 1))
        return None if len(body) > _MAX_REQUEST_BYTES else body

    def _cross_origin_read(self, environ: dict[str, object]) -> bool:
        # A browser sends Origin on every cross-origin fetch, so a host CORS policy cannot expose a
        # read to a foreign page. A top-level navigation sends none.
        return "HTTP_ORIGIN" in environ and not self._same_origin(environ)

    def _same_origin(self, environ: dict[str, object]) -> bool:
        origin = environ.get("HTTP_ORIGIN")
        if not isinstance(origin, str):
            return False
        try:
            parsed = urlsplit(origin)
        except ValueError:
            # An unparsable Origin, such as "https://[", is never evidence of this origin.
            return False
        # An origin is a scheme and an authority. A path also catches two joined Origin headers.
        if not parsed.netloc:
            return False
        if origin.lower() != f"{parsed.scheme}://{parsed.netloc}".lower() or "@" in origin:
            return False
        scheme = str(environ.get("wsgi.url_scheme", "http"))
        host = str(environ.get("HTTP_HOST", ""))
        return _canonical_host(parsed.netloc, parsed.scheme) == _canonical_host(host, scheme)

    def _application(self, actor: str) -> DashboardResponse:
        template = self._bundle_files()["app/index.html"].decode()
        config: dict[str, object] = {
            "basePath": self.base_path,
            "rpcUrl": self.base_path + "/rpc",
            "auditActor": actor,
            "workhorseVersion": _WORKHORSE_VERSION,
            "authentication": None,
            "demoTools": "enqueueTest" in self._procedures,
            "workspaces": [],
            "workspace": None,
        }
        modules = "".join(
            f'<script type="module" src="{escape(source, quote=True)}"></script>'
            for source in self._browser_modules
        )
        html = template.replace(
            "/*__WORKHORSE_RUNTIME_CONFIG__*/",
            "window.workhorseDashboard = "
            + json.dumps(config, separators=(",", ":")).translate(_SCRIPT_ESCAPES),
        ).replace("<!--__WORKHORSE_BROWSER_MODULES__-->", modules)
        return DashboardResponse(
            200,
            html.encode(),
            (("Content-Type", "text/html; charset=utf-8"), ("Cache-Control", "no-store")),
        )

    def _asset(self, name: str) -> DashboardResponse:
        if ".." in name.split("/") or name.startswith("/"):
            return self._json(404, {"error": "Not Found"})
        data = self._bundle_files().get("app/" + name)
        if data is None:
            return self._json(404, {"error": "Not Found"})
        suffix = "." + name.rsplit(".", 1)[-1] if "." in name else ""
        content_type = _CONTENT_TYPES.get(
            suffix, mimetypes.guess_type(name)[0] or "application/octet-stream"
        )
        return DashboardResponse(
            200,
            data,
            (
                ("Content-Type", content_type),
                ("Cache-Control", "public, max-age=31536000, immutable"),
            ),
        )

    def _bundle_files(self) -> dict[str, bytes]:
        if self._assets is not None:
            return self._assets
        with self._assets_lock:
            if self._assets is None:
                resources = importlib.resources.files(__package__)
                manifest = json.loads(resources.joinpath("bundle.json").read_text())
                archive = resources.joinpath(manifest["archive"]).read_bytes()
                files: dict[str, bytes] = {}
                with tarfile.open(fileobj=BytesIO(archive), mode="r:gz") as bundle:
                    for member in bundle.getmembers():
                        if member.isfile():
                            extracted = bundle.extractfile(member)
                            if extracted is not None:
                                files[member.name] = extracted.read()
                self._assets = files
        return self._assets

    @staticmethod
    def _json(status: int, value: object) -> DashboardResponse:
        return DashboardResponse(
            status,
            json.dumps(value, separators=(",", ":"), default=str).encode(),
            (("Content-Type", "application/json; charset=utf-8"),),
        )

    @classmethod
    def _rpc_error(
        cls, status: int, code: str, message: str, data: object | None = None
    ) -> DashboardResponse:
        error: dict[str, object] = {
            "defined": False,
            "code": code,
            "status": status,
            "message": message,
        }
        if data is not None:
            error["data"] = data
        return cls._json(
            status,
            {"json": error},
        )


__all__ = [
    "Authorize",
    "DashboardHost",
    "DashboardPrincipal",
    "DashboardProcedure",
    "DashboardResponse",
]
