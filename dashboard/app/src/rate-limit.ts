import type { DashboardRateLimitPolicySummary } from "@workhorse/dashboard-server/wire";

export const rateLimitCappedFootnote =
  "Rate-limit pressure uses a bounded sample, so throttled counts are lower bounds.";

function intervalLabel(intervalMs: number): string {
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
  if (intervalMs % 1_000 === 0) return `${intervalMs / 1_000}s`;
  return `${intervalMs}ms`;
}

function bucketLabel(bucket: { limit: number; intervalMs: number; burst: number }): string {
  return `${bucket.limit}/${intervalLabel(bucket.intervalMs)} · burst ${bucket.burst}`;
}

export function describeRateLimit(policy: DashboardRateLimitPolicySummary | null): {
  label: string;
  keyedLabel: string | null;
  title: string;
} {
  if (policy === null) {
    return {
      label: "Unlimited",
      keyedLabel: null,
      title: "No durable start-rate policy is configured for this queue.",
    };
  }
  return {
    label: bucketLabel(policy.rate),
    keyedLabel: policy.perKey === null ? null : `${bucketLabel(policy.perKey)} per key`,
    title: `Workhorse admits ${policy.rate.limit} starts every ${intervalLabel(
      policy.rate.intervalMs,
    )}, retaining up to ${policy.rate.burst} tokens after idle time.`,
  };
}

export function describeRateThrottle(policy: DashboardRateLimitPolicySummary | null): {
  label: string;
  title: string;
  throttling: boolean;
} {
  if (policy === null || policy.throttledReady === 0) {
    return {
      label: "0",
      title: "No sampled ready task is waiting for a rate-limit token.",
      throttling: false,
    };
  }
  const next = policy.nextEligibleAt === null ? "the next database refill" : policy.nextEligibleAt;
  return {
    label: `${policy.throttledReady}${policy.throttledKeys > 0 ? ` · ${policy.throttledKeys} keys` : ""}`,
    title: `${policy.throttledReady} sampled ready tasks are waiting for tokens. The earliest can start at ${next}.`,
    throttling: true,
  };
}
