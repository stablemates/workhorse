import { DashboardRefreshHub, type DashboardRefreshReason } from "./refresh.js";

/**
 * The subset of a PostgreSQL client this listener needs.
 *
 * Declaring it structurally keeps `pg` out of the dashboard's dependency tree and lets a host pass
 * whichever driver it already owns. The client must be a dedicated connection, not a pooled one:
 * `LISTEN` registers against a specific backend session.
 */
export interface DashboardNotificationClient {
  query(sql: string): Promise<unknown>;
  on(
    event: "notification",
    listener: (message: { channel: string; payload?: string }) => void,
  ): void;
  on(event: "error", listener: (error: unknown) => void): void;
}

/** Channels the dashboard listens on, and the refresh reason each one maps to. */
export const DASHBOARD_NOTIFICATION_CHANNELS: Readonly<Record<string, DashboardRefreshReason>> = {
  // Dispatch wake hint: ready work may exist.
  workhorse_jobs: "postgres",
  // Operator activity hint: durable state someone is watching changed.
  workhorse_activity: "worker",
};

export interface DashboardNotificationOptions {
  client: DashboardNotificationClient;
  refresh?: DashboardRefreshHub;
  /** Override the channels to listen on. Defaults to every channel Workhorse publishes. */
  channels?: readonly string[];
  /**
   * Minimum delay between refresh events emitted to connected browsers.
   *
   * PostgreSQL notifications arrive one per transaction; without coalescing a busy queue would
   * push a refresh per job into every open SSE stream.
   */
  coalesceMs?: number;
  onError?: (error: unknown) => void;
}

export interface DashboardNotificationListener {
  readonly refresh: DashboardRefreshHub;
  /** Stop coalescing and emitting. The caller still owns closing its own client. */
  close(): void;
}

/**
 * Bridge PostgreSQL notifications into a dashboard refresh hub.
 *
 * This is what lets an operator dashboard stay live while the workers producing the work run in
 * entirely separate processes: nothing in the web tier observes handlers directly, it only reacts
 * to what PostgreSQL announces. Notifications are a liveness optimization and never a source of
 * truth, so a dropped or undelivered notification only delays a refresh until the stream's own
 * periodic fallback fires.
 */
export async function listenForDashboardRefresh(
  options: DashboardNotificationOptions,
): Promise<DashboardNotificationListener> {
  const refresh = options.refresh ?? new DashboardRefreshHub();
  const channels = options.channels ?? Object.keys(DASHBOARD_NOTIFICATION_CHANNELS);
  const coalesceMs = options.coalesceMs ?? 200;

  let closed = false;
  let pending: DashboardRefreshReason | undefined;
  let timer: NodeJS.Timeout | undefined;
  let lastPublishedAt = Number.NEGATIVE_INFINITY;

  const flush = (): void => {
    timer = undefined;
    if (closed || !pending) return;
    const reason = pending;
    pending = undefined;
    lastPublishedAt = Date.now();
    refresh.publish(reason);
  };

  options.client.on("notification", (message) => {
    if (closed) return;
    // A worker-driven activity hint is the more specific signal, so it wins a coalescing window.
    const reason = DASHBOARD_NOTIFICATION_CHANNELS[message.channel] ?? "postgres";
    pending = pending === "worker" ? "worker" : reason;
    if (timer) return;
    timer = setTimeout(flush, Math.max(0, coalesceMs - (Date.now() - lastPublishedAt)));
    timer.unref?.();
  });

  options.client.on("error", (error) => {
    options.onError?.(error);
  });

  for (const channel of channels) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(channel)) {
      throw new Error(`Unsafe notification channel name: ${channel}`);
    }
    await options.client.query(`LISTEN ${channel}`);
  }

  return {
    refresh,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}
