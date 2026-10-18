/**
 * The deadline of one heartbeat round on the reserved connection, in milliseconds, for an interval
 * of `heartbeatMs`.
 *
 * It is three quarters of the interval, so that one timed-out round leaves a renewal margin when
 * `2 × heartbeatMs + bound < leaseMs`. Below an interval of 200 ms the bound is at least
 * `min(50, heartbeatMs)` ms. Up to 50 ms the bound thus equals the interval, as before SM-1444, and a
 * timed-out round leaves about no margin. It is at least 1 ms. Every SDK uses the same formula.
 */
export function heartbeatRoundBoundMs(heartbeatMs: number): number {
  return Math.max(1, Math.floor((heartbeatMs * 3) / 4), Math.min(50, heartbeatMs));
}
