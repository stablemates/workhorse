"""Framework-neutral WSGI host for the embedded Workhorse dashboard."""

from __future__ import annotations

import importlib.resources
import json
import mimetypes
import tarfile
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from html import escape
from http import HTTPStatus
from io import BytesIO
from threading import Lock
from typing import Any, Protocol, cast
from urllib.parse import urlsplit

from .._compatibility import assert_sync_compatible as _assert_sync_compatible
from .._drivers import PsycopgConnection as _PsycopgConnection, SyncExecutor as _SyncExecutor
from ..dashboard_v1 import DashboardInputValidationError, validate_input
from ._backend import DashboardBackend as _DashboardBackend
from ._errors import DashboardRPCError as _DashboardRPCError

_MUTATIONS = frozenset(
    {
        "enqueueTest",
        "setScheduleEnabled",
        "setQueuePaused",
        "purgeQueue",
        "setWorkerPaused",
        "overrideMaintenancePolicy",
        "revertMaintenancePolicy",
        "overrideRetentionPolicy",
        "revertRetentionPolicy",
        "runTaskNow",
        "cancelTask",
        "signalTask",
        "completeHumanWait",
    }
)
_OPTIONAL_MUTATIONS = frozenset({"enqueueTest", "setScheduleEnabled"})
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


def _normalize_dashboard_path(path: str) -> str:
    normalized = "/" + "/".join(part for part in path.split("/") if part)
    return "" if normalized == "/" else normalized


class DashboardHost:
    """A WSGI application serving one embedded dashboard and its RPC contract."""

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
        set_schedule_enabled: DashboardProcedure | None = None,
        _procedures: Mapping[str, DashboardProcedure] | None = None,
        _skip_compatibility_check: bool = False,
    ) -> None:
        if getattr(connection, "autocommit", None) is not True:
            raise ValueError("dashboard connection must use autocommit=True")
        self.base_path = _normalize_dashboard_path(path)
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
        )
        extensions = dict(_procedures or {})
        if enqueue_test is not None:
            extensions["enqueueTest"] = enqueue_test
        if set_schedule_enabled is not None:
            extensions["setScheduleEnabled"] = set_schedule_enabled
        self._procedures = {**backend.procedures(), **extensions}
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
        authorization = self._authorize(environ)
        if isinstance(authorization, DashboardResponse):
            return authorization
        if authorization is False:
            return self._json(401, {"error": "Unauthorized"})
        if authorization is True:
            principal = DashboardPrincipal(self._audit_actor or "dashboard")
        else:
            principal = authorization
        actor = self._audit_actor or principal.actor
        try:
            self._assert_compatible()
        except Exception as error:
            return self._json(503, {"error": str(error)})

        mount_root = self.base_path or "/"
        if path == mount_root:
            return DashboardResponse(302, b"", (("Location", self.base_path + "/tasks"),))
        asset_prefix = self.base_path + "/assets/"
        if path.startswith(asset_prefix):
            return self._asset(path[len(self.base_path) + 1 :])
        rpc_prefix = self.base_path + "/rpc/dashboard/"
        if path.startswith(rpc_prefix):
            return self._rpc(environ, path[len(rpc_prefix) :], actor)
        return self._application(actor)

    def _assert_compatible(self) -> None:
        if self._skip_compatibility_check or self._compatible:
            return
        with self._compatibility_lock:
            if not self._compatible:
                _assert_sync_compatible(self._executor)
                self._compatible = True

    def _rpc(self, environ: dict[str, object], procedure: str, actor: str) -> DashboardResponse:
        if str(environ.get("REQUEST_METHOD", "GET")) != "POST":
            return self._rpc_error(405, "METHOD_NOT_SUPPORTED", "Method Not Supported")
        if procedure in _MUTATIONS:
            if not self._same_origin(environ):
                return self._json(403, {"error": "A same-origin mutation request is required"})
            if self._read_only:
                return self._rpc_error(403, "FORBIDDEN", "This dashboard is read-only")
        handler = self._procedures.get(procedure)
        if handler is None:
            if procedure in _OPTIONAL_MUTATIONS:
                return self._rpc_error(403, "FORBIDDEN", "This procedure is not available")
            return self._rpc_error(404, "NOT_FOUND", "Procedure not found")
        try:
            length = int(str(environ.get("CONTENT_LENGTH", "0")) or "0")
            stream = cast(Any, environ["wsgi.input"])
            envelope = json.loads(stream.read(length) or b"{}")
            if not isinstance(envelope, dict):
                raise DashboardInputValidationError("request envelope must be an object")
            input_value = envelope.get("json")
            validate_input(procedure, input_value)
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
            if isinstance(input_value, dict) and isinstance(input_value.get("audit"), dict):
                input_value = dict(input_value)
                input_value["audit"] = {**input_value["audit"], "actor": actor}
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
            return self._rpc_error(400, "BAD_REQUEST", str(error))
        except _DashboardRPCError as error:
            return self._rpc_error(error.status, error.code, error.message, error.data)
        except Exception:
            return self._rpc_error(500, "INTERNAL_SERVER_ERROR", "Internal server error")
        return self._json(200, {} if result is None else {"json": result})

    def _same_origin(self, environ: dict[str, object]) -> bool:
        origin = environ.get("HTTP_ORIGIN")
        if not isinstance(origin, str):
            return False
        parsed = urlsplit(origin)
        if not parsed.scheme or not parsed.netloc:
            return False
        scheme = str(environ.get("wsgi.url_scheme", "http"))
        host = str(environ.get("HTTP_HOST", ""))
        return f"{parsed.scheme}://{parsed.netloc}" == f"{scheme}://{host}"

    def _application(self, actor: str) -> DashboardResponse:
        template = self._bundle_files()["app/index.html"].decode()
        config: dict[str, object] = {
            "basePath": self.base_path,
            "rpcUrl": self.base_path + "/rpc",
            "auditActor": actor,
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
            "window.workhorseDashboard = " + json.dumps(config, separators=(",", ":")),
        ).replace("<!--__WORKHORSE_BROWSER_MODULES__-->", modules)
        return DashboardResponse(
            200, html.encode(), (("Content-Type", "text/html; charset=utf-8"),)
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
