from __future__ import annotations

from collections.abc import Sequence

import pytest

from workhorse._statements import DriverStatement
from workhorse.admin import AdminAudit, QueueHistory
from workhorse.dashboard._backend import DashboardBackend
from workhorse.errors import FastTierUnsupportedError

_AUDIT = {"actor": "browser-operator", "reason": "switch tier", "requestId": "request-1"}


class _Executor:
    dialect = "psycopg"

    def rows(
        self, _statement: DriverStatement, _parameters: Sequence[object] = ()
    ) -> list[dict[str, object]]:
        raise AssertionError("the backend must call the admin client")


class _Admin:
    """Record each admin call and answer with a fixed result or error."""

    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[tuple[object, ...]] = []

    def set_queue_tier(self, queue_name: str, tier: str, audit: AdminAudit) -> str:
        self.calls.append((queue_name, tier, audit))
        if self.error is not None:
            raise self.error
        return tier

    def set_queue_history(
        self,
        queue_name: str,
        *,
        record_attempts: bool | None = None,
        record_claims: bool | None = None,
    ) -> QueueHistory:
        self.calls.append((queue_name, record_attempts, record_claims))
        return QueueHistory(record_attempts=bool(record_attempts), record_claims=True)


def _backend(admin: _Admin) -> DashboardBackend:
    backend = DashboardBackend(
        _Executor(),  # type: ignore[arg-type]
        environment="test",
        configured_workers=(),
        maintenance_loops={},
        read_only=False,
    )
    backend._admin = admin  # type: ignore[assignment]
    return backend


def test_set_queue_tier_answers_the_tier_and_audits_the_principal() -> None:
    admin = _Admin()

    result = _backend(admin).set_queue_tier(
        {"queue": "billing", "tier": "fast", "audit": _AUDIT}, "signed-in-operator"
    )

    assert result == {"status": "set", "tier": "fast"}
    assert admin.calls == [
        ("billing", "fast", AdminAudit("signed-in-operator", "switch tier", "request-1"))
    ]


@pytest.mark.parametrize(
    ("feature", "status"),
    [
        ("tier change", "live_tasks"),
        ("concurrency policies", "concurrency_policy"),
        ("rate-limit policies", "rate_limit_policy"),
    ],
)
def test_set_queue_tier_answers_a_refused_switch_as_a_status(feature: str, status: str) -> None:
    admin = _Admin(FastTierUnsupportedError("billing", feature))

    result = _backend(admin).set_queue_tier(
        {"queue": "billing", "tier": "fast", "audit": _AUDIT}, "operator"
    )

    assert result == {"status": status, "tier": None}


def test_set_queue_tier_raises_an_unknown_refusal() -> None:
    admin = _Admin(FastTierUnsupportedError("billing", "task groups"))

    with pytest.raises(FastTierUnsupportedError):
        _backend(admin).set_queue_tier(
            {"queue": "billing", "tier": "fast", "audit": _AUDIT}, "operator"
        )


def test_set_queue_history_keeps_an_omitted_setting() -> None:
    admin = _Admin()

    result = _backend(admin).set_queue_history(
        {"queue": "billing", "recordAttempts": True, "audit": _AUDIT}, "operator"
    )

    assert result == {"recordAttempts": True, "recordClaims": True}
    assert admin.calls == [("billing", True, None)]
