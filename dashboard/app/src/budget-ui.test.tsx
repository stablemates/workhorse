import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import type { DashboardBudgetSummary } from "@stablemates/workhorse-dashboard-server/wire";
import { describeBudgetBlocked, describeBudgetLimit, describeBudgetRate } from "./budget.js";

// The table module reaches the dashboard shell, which reads localStorage at import time.
Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});
const { BudgetsTable, budgetCappedFootnote } = await import("./budgets-table.js");
const { healthCheckMessages } = await import("./presentation-policy.js");

function budget(overrides: Partial<DashboardBudgetSummary> = {}): DashboardBudgetSummary {
  return {
    name: "vendor-api",
    namespace: "workers",
    maxActive: 3,
    rate: { limit: 10, intervalMs: 1_000, burst: 20 },
    active: 3,
    availableTokens: 4.5,
    blockedReady: 2,
    saturated: true,
    nextEligibleAt: null,
    ...overrides,
  };
}

function render(budgets: DashboardBudgetSummary[]): string {
  return renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(BudgetsTable, { budgets })),
  );
}

describe("named budget presentation", () => {
  it("describes concurrency, rate, and blocked facts for a budget with both limits", () => {
    expect(describeBudgetLimit(budget()).label).toBe("3 / 3");
    expect(describeBudgetRate(budget()).label).toBe("10/1s · burst 20 · 4 tokens");
    expect(describeBudgetBlocked(budget())).toMatchObject({ label: "2", blocking: true });
  });

  it("marks the missing half of a single-limit budget instead of inventing a value", () => {
    expect(describeBudgetLimit(budget({ maxActive: null })).label).toBe("—");
    expect(describeBudgetRate(budget({ rate: null, availableTokens: null })).label).toBe("—");
    expect(describeBudgetBlocked(budget({ saturated: false, blockedReady: 0 }))).toMatchObject({
      label: "0",
      blocking: false,
    });
  });

  it("renders one row per budget with the namespace and no raw key values", () => {
    const markup = render([budget(), budget({ name: "slow-partner", maxActive: null })]);
    expect(markup).toContain("vendor-api");
    expect(markup).toContain("slow-partner");
    expect(markup).toContain("workers");
    expect(markup).toContain("Budgets table");
    expect(markup).not.toContain(budgetCappedFootnote);
  });

  it("explains a budget-blocked health reason with the budget name", () => {
    const { degradedChecks } = healthCheckMessages([
      {
        code: "budget-blocked",
        severity: "degraded",
        observed: 4,
        budget: 0,
        budgetName: "vendor-api",
      },
    ]);
    expect(degradedChecks).toHaveLength(1);
    expect(degradedChecks[0]?.message).toContain("vendor-api");
    expect(degradedChecks[0]?.message).toContain("4+");
  });
});
