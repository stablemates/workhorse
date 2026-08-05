import type { DashboardRefreshEvent, DashboardRefreshReason } from "./server/refresh.js";

export type { DashboardRefreshEvent, DashboardRefreshReason };

/**
 * Connection state of the refresh stream, as an operator needs to read it.
 *
 * `offline` matters more than it looks: a feed that has silently stopped receiving events is
 * indistinguishable from a quiet system, so the dashboard has to be able to say which one it is.
 */
export type DashboardLiveStatus = "connecting" | "live" | "offline";

export interface DashboardLiveRefreshOptions {
  /** Absolute or mount-relative URL of the host's `text/event-stream` endpoint. */
  url: string;
  onRefresh: () => void;
  onStatus?: (status: DashboardLiveStatus) => void;
  /**
   * Smallest gap between delivered refreshes.
   *
   * The host already coalesces PostgreSQL notifications, but a busy queue can still produce a
   * frame every few hundred milliseconds, and each delivered refresh costs a full page query. The
   * throttle is trailing-edge so a burst collapses to one refetch without dropping the last event.
   */
  throttleMs?: number;
}

const DEFAULT_THROTTLE_MS = 750;

/**
 * Subscribe the dashboard to the host's server-sent refresh stream.
 *
 * The stream carries no data the dashboard renders — every frame is a hint that something durable
 * changed, and the page re-reads through its normal queries. That is deliberate: the underlying
 * PostgreSQL notifications are coalesced and are dropped while nothing is listening, so treating
 * them as a record of what happened would produce a feed with invisible holes. Treated as a wake
 * signal instead, a missed frame costs nothing beyond a slightly later refetch.
 *
 * `connected` is not delivered as a refresh. It arrives when the stream opens, at which point the
 * caller has just loaded the page it would otherwise reload.
 *
 * Returns an unsubscribe function. Safe to call in an environment without `EventSource`, where it
 * reports `offline` and does nothing else, so a host rendering without a browser global does not
 * throw.
 */
export function subscribeDashboardRefresh(options: DashboardLiveRefreshOptions): () => void {
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const status = (next: DashboardLiveStatus) => options.onStatus?.(next);

  if (typeof EventSource === "undefined") {
    status("offline");
    return () => undefined;
  }

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastDelivered = 0;
  let pending = false;

  const deliver = () => {
    pending = false;
    lastDelivered = Date.now();
    options.onRefresh();
  };
  const schedule = () => {
    if (closed || pending) return;
    const wait = Math.max(0, lastDelivered + throttleMs - Date.now());
    if (wait === 0) {
      deliver();
      return;
    }
    pending = true;
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) deliver();
    }, wait);
  };

  status("connecting");
  const source = new EventSource(options.url);

  source.addEventListener("open", () => status("live"));
  source.addEventListener("refresh", (event) => {
    status("live");
    let reason: DashboardRefreshReason | null = null;
    try {
      reason = (JSON.parse((event as MessageEvent<string>).data) as DashboardRefreshEvent).reason;
    } catch {
      // A frame the dashboard cannot parse is still evidence the host is alive and something
      // changed, so it refreshes rather than discarding the signal.
    }
    if (reason === "connected") return;
    schedule();
  });
  source.addEventListener("error", () => {
    // EventSource reconnects on its own unless it has been closed outright; report the gap either
    // way so the caller can fall back to polling while the stream is down.
    status(source.readyState === source.CLOSED ? "offline" : "connecting");
  });

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    source.close();
    status("offline");
  };
}
