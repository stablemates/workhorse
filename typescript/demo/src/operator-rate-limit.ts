import { isDashboardMutation } from "@stablemates/workhorse-dashboard/server";

const DEMO_OPERATOR_RATE_LIMIT_PER_MINUTE = 12;
const DEMO_OPERATOR_RATE_LIMIT_BURST = 5;
const DEMO_OPERATOR_RATE_LIMIT_MAX_CLIENTS = 10_000;

interface ClientBucket {
  tokens: number;
  updatedAt: number;
}

interface RateLimitedRequest {
  headers: {
    [name: string]: string | string[] | undefined;
    "x-forwarded-for"?: string | string[] | undefined;
  };
  method?: string | undefined;
  socket: { remoteAddress?: string | undefined };
  url?: string | undefined;
}

/** Return the client address appended by the trusted deployment proxy. */
export function demoClientAddress(request: RateLimitedRequest): string {
  const forwardedFor = request.headers["x-forwarded-for"];
  const value = Array.isArray(forwardedFor) ? forwardedFor.at(-1) : forwardedFor;
  const forwardedAddress = value?.split(",").at(-1)?.trim();
  return forwardedAddress || request.socket.remoteAddress || "unknown";
}

export function isDemoOperatorMutation(
  request: Pick<RateLimitedRequest, "method" | "url">,
): boolean {
  if (request.method !== "POST" || !request.url) return false;
  const pathname = new URL(request.url, "http://demo.invalid").pathname;
  const segments = pathname.split("/");
  return (
    segments.at(-2) === "dashboard" && isDashboardMutation(`dashboard.${segments.at(-1) ?? ""}`)
  );
}

/** A process-local token bucket for the public demo's operator RPC surface. */
export class DemoOperatorRateLimiter {
  readonly #buckets = new Map<string, ClientBucket>();

  check(request: RateLimitedRequest, now = Date.now()): number | undefined {
    if (!isDemoOperatorMutation(request)) return undefined;

    const address = demoClientAddress(request);
    const previous = this.#buckets.get(address);
    const tokens = previous
      ? Math.min(
          DEMO_OPERATOR_RATE_LIMIT_BURST,
          previous.tokens +
            ((now - previous.updatedAt) * DEMO_OPERATOR_RATE_LIMIT_PER_MINUTE) / 60_000,
        )
      : DEMO_OPERATOR_RATE_LIMIT_BURST;

    if (previous) this.#buckets.delete(address);
    this.#buckets.set(address, {
      tokens: tokens >= 1 ? tokens - 1 : tokens,
      updatedAt: now,
    });
    this.#evictOldestClients();

    if (tokens >= 1) return undefined;
    return Math.max(1, Math.ceil(((1 - tokens) * 60) / DEMO_OPERATOR_RATE_LIMIT_PER_MINUTE));
  }

  #evictOldestClients(): void {
    while (this.#buckets.size > DEMO_OPERATOR_RATE_LIMIT_MAX_CLIENTS) {
      const oldest = this.#buckets.keys().next().value;
      if (oldest === undefined) return;
      this.#buckets.delete(oldest);
    }
  }
}
