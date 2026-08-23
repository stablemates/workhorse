from __future__ import annotations

import io
import json
from collections.abc import Callable, Iterable
from typing import cast

import pytest

from workhorse.dashboard import DashboardHost, DashboardPrincipal, DashboardResponse


class _Connection:
    autocommit = True

    def cursor(self) -> object:
        raise AssertionError("the transport test must not query PostgreSQL")


def _request(
    host: DashboardHost,
    path: str,
    *,
    method: str = "GET",
    body: object | None = None,
    origin: str | None = None,
) -> tuple[str, dict[str, str], bytes]:
    payload = b"" if body is None else json.dumps(body).encode()
    environ: dict[str, object] = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "wsgi.url_scheme": "https",
        "HTTP_HOST": "example.test",
        "CONTENT_LENGTH": str(len(payload)),
        "CONTENT_TYPE": "application/json",
        "wsgi.input": io.BytesIO(payload),
    }
    if origin is not None:
        environ["HTTP_ORIGIN"] = origin
    captured: dict[str, object] = {}

    def start_response(status: str, headers: list[tuple[str, str]]) -> None:
        captured["status"] = status
        captured["headers"] = dict(headers)

    chunks = cast(Iterable[bytes], host(environ, start_response))
    return (
        cast(str, captured["status"]),
        cast(dict[str, str], captured["headers"]),
        b"".join(chunks),
    )


def _host(
    authorize: Callable[[dict[str, object]], DashboardPrincipal | bool] = lambda _: (
        DashboardPrincipal("operator@example.test")
    ),
) -> DashboardHost:
    return DashboardHost(
        cast(object, _Connection()),
        authorize=authorize,
        environment="test",
        _procedures={"meta": lambda _input, actor: {"environment": "test", "actor": actor}},
        _skip_compatibility_check=True,
    )


def test_dashboard_host_serves_the_embedded_application() -> None:
    status, headers, _ = _request(_host(), "/workhorse")
    assert status == "302 Found"
    assert headers["Location"] == "/workhorse/tasks"

    status, headers, body = _request(_host(), "/workhorse/tasks")
    assert status == "200 OK"
    assert headers["Content-Type"] == "text/html; charset=utf-8"
    assert b'"basePath":"/workhorse"' in body
    assert b'"auditActor":"operator@example.test"' in body

    root = DashboardHost(
        cast(object, _Connection()),
        path="/",
        authorize=lambda _: DashboardPrincipal("operator@example.test"),
        _skip_compatibility_check=True,
    )
    status, headers, _ = _request(root, "/")
    assert status == "302 Found"
    assert headers["Location"] == "/tasks"


def test_dashboard_host_requires_autocommit() -> None:
    connection = _Connection()
    connection.autocommit = False
    with pytest.raises(ValueError, match="autocommit=True"):
        DashboardHost(cast(object, connection), authorize=lambda _: True)


def test_dashboard_host_authorizes_before_dispatch() -> None:
    called = False

    def deny(_request: dict[str, object]) -> bool:
        nonlocal called
        called = True
        return False

    status, _, body = _request(_host(deny), "/workhorse/rpc/dashboard/meta", method="POST")
    assert called is True
    assert status == "401 Unauthorized"
    assert json.loads(body) == {"error": "Unauthorized"}


def test_dashboard_host_returns_custom_authorization_responses() -> None:
    def deny(_request: dict[str, object]) -> DashboardResponse:
        return DashboardResponse(429, b"slow down", (("Content-Length", "9"),))

    status, headers, body = _request(_host(deny), "/workhorse/tasks")
    assert status == "429 Too Many Requests"
    assert headers["Content-Length"] == "9"
    assert body == b"slow down"


def test_dashboard_host_requires_same_origin_before_a_mutation() -> None:
    host = DashboardHost(
        cast(object, _Connection()),
        authorize=lambda _: DashboardPrincipal("trusted-actor"),
        _procedures={"purgeQueue": lambda _input, _actor: {"deletedCount": 1}},
        _skip_compatibility_check=True,
    )
    status, _, body = _request(
        host,
        "/workhorse/rpc/dashboard/purgeQueue",
        method="POST",
        origin="https://attacker.test",
        body={
            "json": {
                "queue": "default",
                "audit": {"actor": "fake", "reason": "x", "requestId": "r"},
            }
        },
    )
    assert status == "403 Forbidden"
    assert json.loads(body) == {"error": "A same-origin mutation request is required"}


def test_dashboard_host_assigns_the_authenticated_actor() -> None:
    status, _, body = _request(
        _host(),
        "/workhorse/rpc/dashboard/meta",
        method="POST",
        body={"json": None},
    )
    assert status == "200 OK"
    assert json.loads(body) == {"json": {"environment": "test", "actor": "operator@example.test"}}


def test_dashboard_host_forbids_an_unavailable_optional_mutation() -> None:
    status, _, body = _request(
        _host(),
        "/workhorse/rpc/dashboard/setScheduleEnabled",
        method="POST",
        origin="https://example.test",
        body={"json": None},
    )
    assert status == "403 Forbidden"
    assert json.loads(body) == {
        "json": {
            "code": "FORBIDDEN",
            "defined": False,
            "message": "This procedure is not available",
            "status": 403,
        }
    }
