"""The transaction statements around one heartbeat round on the dedicated connection.

They are not protocol calls, so they do not live in the generated catalogue. The round sends the
catalogue's `heartbeat_pool_v1` statement unchanged between them.
"""

from __future__ import annotations

import random
from collections.abc import Callable

from ._statements import DriverStatement


def heartbeat_round_bound_ms(heartbeat_ms: int) -> int:
    """The deadline of one heartbeat round on the dedicated connection, in milliseconds.

    It is three quarters of the interval, so that one timed-out round leaves a renewal margin when
    ``2 * heartbeat_ms + bound < lease_ms``. Below an interval of 200 ms the bound is at least
    ``min(50, heartbeat_ms)`` ms. Up to 50 ms the bound thus equals the interval, as before SM-1444,
    and a timed-out round leaves about no margin. It is at least 1 ms. Every SDK uses the same
    formula.
    """
    return max(1, heartbeat_ms * 3 // 4, min(50, heartbeat_ms))


# A bounded round with less time than this left, in milliseconds, fails before it sends its
# heartbeat.
MINIMUM_ROUND_REMAINING_MS = 8

# The longest base delay before a busy retry, in milliseconds.
BUSY_RETRY_BASE_MS = 100
BUSY_RETRY_MARGIN_MS = 12
# A bounded busy retry with less time than this before its deadline, in milliseconds, does not
# start. It is the time a round needs at the settings statement, plus a margin for the payload, the
# wait for the connection, and BEGIN.
BUSY_RETRY_MINIMUM_MS = MINIMUM_ROUND_REMAINING_MS + BUSY_RETRY_MARGIN_MS


def busy_retry_delay_ms(heartbeat_ms: int, sample: Callable[[], float] = random.random) -> float:
    """The wait before a round renews the leases that the previous round reported busy.

    It is ``base * (1 + random)``, with ``base = min(BUSY_RETRY_BASE_MS, heartbeat_ms / 8)``. The
    jitter keeps two workers from meeting the same lock holder in step. Every SDK uses the same
    formula.
    """
    return min(BUSY_RETRY_BASE_MS, heartbeat_ms / 8) * (1 + sample())


ROUND_BEGIN = DriverStatement(psycopg="BEGIN", asyncpg="BEGIN")
ROUND_COMMIT = DriverStatement(psycopg="COMMIT", asyncpg="COMMIT")
ROUND_ROLLBACK = DriverStatement(psycopg="ROLLBACK", asyncpg="ROLLBACK")
# Sets both server timeouts for the current transaction only. SET LOCAL cannot take a bind
# parameter, and set_config(..., true) has the same scope.
ROUND_TIMEOUTS = DriverStatement(
    psycopg="SELECT set_config('statement_timeout', %s, true), "
    "set_config('idle_in_transaction_session_timeout', %s, true)",
    asyncpg="SELECT set_config('statement_timeout', $1, true), "
    "set_config('idle_in_transaction_session_timeout', $2, true)",
)
