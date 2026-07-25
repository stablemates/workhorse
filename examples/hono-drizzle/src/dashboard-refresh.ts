export type DashboardRefreshReason = "connected" | "enqueue" | "worker" | "postgres" | "fallback";

export interface DashboardRefreshEvent {
  reason: DashboardRefreshReason;
  occurredAt: string;
}

export class DashboardRefreshHub {
  private readonly listeners = new Set<(event: DashboardRefreshEvent) => void>();

  publish(reason: DashboardRefreshReason): void {
    const event = { reason, occurredAt: new Date().toISOString() } satisfies DashboardRefreshEvent;
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: DashboardRefreshEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
