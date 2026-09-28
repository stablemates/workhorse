"""Send a fenced write again when PostgreSQL chose it as a deadlock victim.

Settling a task resolves its dependents inside the same statement, and the resolver locks each
level of that cascade only when it reaches it. Two settlements whose cascades meet at different
levels can therefore wait on each other, and PostgreSQL then raises 40P01 in one of them.

The concurrency policy sync is sent through the same helpers. Its prune can deadlock with a
release over several capped queues, and a resend writes the same complete desired set.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from ._compatibility import AsyncRowExecutor, SyncRowExecutor
from ._statements import DriverStatement

# Times one fenced write is sent at most when PostgreSQL rolls it back as a deadlock victim.
FENCED_WRITE_DEADLOCK_ATTEMPTS = 3
_DEADLOCK_DETECTED_SQLSTATE = "40P01"
_IN_FAILED_SQL_TRANSACTION_SQLSTATE = "25P02"

_Rows = list[Mapping[str, object]]


def fenced_write_rows(
    executor: SyncRowExecutor, statement: DriverStatement, parameters: Sequence[object]
) -> _Rows:
    """Send a fenced write, and send it again when PostgreSQL chose it as a deadlock victim.

    PostgreSQL rolls back the whole statement, so nothing in it committed, and the fence decides
    again whether a resend may still act. A caller-owned transaction is aborted by the deadlock, so
    a resend there fails with 25P02, and the caller gets the original deadlock instead.
    """
    deadlock: Exception | None = None
    attempt = 1
    while True:
        try:
            return executor.rows(statement, parameters)
        except Exception as error:
            deadlock = _deadlock_to_resend(error, deadlock, attempt)
            attempt += 1


async def async_fenced_write_rows(
    executor: AsyncRowExecutor, statement: DriverStatement, parameters: Sequence[object]
) -> _Rows:
    """Await a fenced write, and send it again as `fenced_write_rows` does."""
    deadlock: Exception | None = None
    attempt = 1
    while True:
        try:
            return await executor.rows(statement, parameters)
        except Exception as error:
            deadlock = _deadlock_to_resend(error, deadlock, attempt)
            attempt += 1


def _deadlock_to_resend(error: Exception, deadlock: Exception | None, attempt: int) -> Exception:
    """Return the deadlock to resend after `error`, or raise what the caller should see."""
    sqlstate = getattr(error, "sqlstate", None) or getattr(error, "code", None)
    if deadlock is not None and sqlstate == _IN_FAILED_SQL_TRANSACTION_SQLSTATE:
        raise deadlock from None
    if attempt >= FENCED_WRITE_DEADLOCK_ATTEMPTS or sqlstate != _DEADLOCK_DETECTED_SQLSTATE:
        raise error
    return error
