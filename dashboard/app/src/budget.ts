import type { DashboardBudgetSummary } from "@stablemates/workhorse-dashboard-server/wire";

export const budgetCappedFootnote =
  "Budget pressure uses a bounded sample, so budget counts and blocked task counts are lower bounds.";

function intervalLabel(intervalMs: number): string {
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
  if (intervalMs % 1_000 === 0) return `${intervalMs / 1_000}s`;
  return `${intervalMs}ms`;
}

/** The concurrency half of a budget row: active over limit, or a dash when it has no cap. */
export function describeBudgetLimit(budget: DashboardBudgetSummary): {
  label: string;
  title: string;
} {
  if (budget.maxActive === null) {
    return {
      label: "—",
      title: "This budget limits start rate only; it does not cap active tasks.",
    };
  }
  return {
    label: `${budget.active} / ${budget.maxActive}`,
    title: `${budget.active} unexpired active tasks across every queue naming this budget, out of ${budget.maxActive} allowed.`,
  };
}

/** The rate half of a budget row: the bucket definition and its refilled tokens. */
export function describeBudgetRate(budget: DashboardBudgetSummary): {
  label: string;
  title: string;
} {
  if (budget.rate === null) {
    return {
      label: "—",
      title: "This budget caps active tasks only; it does not limit start rate.",
    };
  }
  const tokens =
    budget.availableTokens === null ? "" : ` · ${Math.floor(budget.availableTokens)} tokens`;
  return {
    label: `${budget.rate.limit}/${intervalLabel(budget.rate.intervalMs)} · burst ${budget.rate.burst}${tokens}`,
    title: `Workhorse admits ${budget.rate.limit} starts every ${intervalLabel(
      budget.rate.intervalMs,
    )} across every queue naming this budget, retaining up to ${budget.rate.burst} tokens after idle time.`,
  };
}

/** Whether the budget refuses the next start, and how much sampled ready work waits on it. */
export function describeBudgetBlocked(budget: DashboardBudgetSummary): {
  label: string;
  title: string;
  blocking: boolean;
} {
  if (!budget.saturated) {
    return { label: "0", title: "This budget has capacity for the next start.", blocking: false };
  }
  const next =
    budget.nextEligibleAt === null ? "the next lease release" : `${budget.nextEligibleAt}`;
  return {
    label: `${budget.blockedReady}`,
    title: `${budget.blockedReady} sampled ready tasks across queues wait on this budget. The earliest can start at ${next}.`,
    blocking: budget.blockedReady > 0,
  };
}
