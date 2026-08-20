import { describe, expect, it } from "vitest";
import type { DashboardHumanWaitRow } from "@workhorse-js/dashboard-server/wire";
import {
  filterExternalWaits,
  humanWaitResultsDirty,
  humanWaitQuickAction,
  isHumanWaitOverdue,
  orderHumanWaits,
  parseHumanWaitResult,
} from "./presentation.js";

function wait(name: string, deadlineAt: string): DashboardHumanWaitRow {
  return {
    jobId: `job-${name}`,
    queue: "default",
    jobType: "approval",
    name,
    context: null,
    attempt: 1,
    createdAt: "2026-08-15T12:00:00.000Z",
    deadlineAt,
  };
}

describe("human wait decisions", () => {
  it("orders overdue decisions before upcoming decisions and nearest deadlines first", () => {
    const ordered = orderHumanWaits(
      [
        wait("later", "2026-08-15T15:00:00.000Z"),
        wait("oldest-overdue", "2026-08-15T11:00:00.000Z"),
        wait("next", "2026-08-15T14:00:00.000Z"),
        wait("recent-overdue", "2026-08-15T13:00:00.000Z"),
      ],
      Date.parse("2026-08-15T13:30:00.000Z"),
    );

    expect(ordered.map(({ name }) => name)).toEqual([
      "oldest-overdue",
      "recent-overdue",
      "next",
      "later",
    ]);
    expect(
      isHumanWaitOverdue(
        wait("deadline-now", "2026-08-15T13:30:00.000Z"),
        Date.parse("2026-08-15T13:30:00.000Z"),
      ),
    ).toBe(true);
  });

  it("pretty-prints every valid JSON value without replacing invalid input", () => {
    expect(parseHumanWaitResult('{"approved":true,"reason":"verified"}')).toEqual({
      value: { approved: true, reason: "verified" },
      formatted: '{\n  "approved": true,\n  "reason": "verified"\n}',
    });
    expect(parseHumanWaitResult("null")).toEqual({ value: null, formatted: "null" });
    expect(parseHumanWaitResult("not JSON")).toBeNull();
  });

  it("filters overdue decisions and searches their operator-visible identity", () => {
    const waits = [
      wait("finance-approval", "2026-08-15T12:00:00.000Z"),
      { ...wait("legal-review", "2026-08-15T15:00:00.000Z"), queue: "compliance" },
    ];

    expect(
      filterExternalWaits(waits, {
        search: "finance",
        overdueOnly: false,
        nowMs: Date.parse("2026-08-15T13:00:00.000Z"),
      }).map(({ name }) => name),
    ).toEqual(["finance-approval"]);
    expect(
      filterExternalWaits(waits, {
        search: "",
        overdueOnly: true,
        nowMs: Date.parse("2026-08-15T13:00:00.000Z"),
      }).map(({ name }) => name),
    ).toEqual(["finance-approval"]);
  });

  it("filters every external-wait kind through the same task identity fields", () => {
    const waits = [
      wait("finance-approval", "2026-08-15T12:00:00.000Z"),
      { ...wait("catalog-signal", "2026-08-15T15:00:00.000Z"), queue: "publishing" },
    ];

    expect(
      filterExternalWaits(waits, {
        search: "publishing",
        overdueOnly: false,
        nowMs: Date.parse("2026-08-15T13:00:00.000Z"),
      }).map(({ name }) => name),
    ).toEqual(["catalog-signal"]);
  });

  it("exposes only application-defined dashboard quick actions", () => {
    expect(
      humanWaitQuickAction({
        prompt: "Approve this account?",
        dashboard: { quickAction: { label: "Approve", result: { approved: true } } },
      }),
    ).toEqual({
      label: "Approve",
      result: { approved: true },
      formatted: '{\n  "approved": true\n}',
    });
    expect(humanWaitQuickAction({ prompt: "Choose a region" })).toBeNull();
    expect(
      humanWaitQuickAction({ dashboard: { quickAction: { label: "", result: true } } }),
    ).toBeNull();
  });

  it("blocks refresh only while at least one decision has composed input", () => {
    expect(humanWaitResultsDirty({ approval: "", review: "  " })).toBe(false);
    expect(humanWaitResultsDirty({ approval: "", review: '{"approved":true}' })).toBe(true);
  });
});
