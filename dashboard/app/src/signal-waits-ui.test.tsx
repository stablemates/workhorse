import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardJobRow, DashboardSignalWaitRow } from "@workhorse/dashboard-server/wire";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

const signalWait: DashboardSignalWaitRow = {
  jobId: "signal-job",
  queue: "default",
  jobType: "approval-task",
  name: "account-approval",
  attempt: 1,
  createdAt: "2026-08-16T03:00:00.000Z",
  deadlineAt: "2026-08-17T03:00:00.000Z",
};

describe("dashboard signal waits", () => {
  it("marks a task row as waiting for its named signal", async () => {
    const { TaskWaitBadge } = await import("./dashboard.js");
    const job = {
      state: "scheduled",
      wait: null,
      signalWait: { name: signalWait.name, deadlineAt: signalWait.deadlineAt },
    } as DashboardJobRow;
    const html = renderToStaticMarkup(
      createElement(MantineProvider, null, createElement(TaskWaitBadge, { job })),
    );

    expect(html).toContain("Waiting for signal");
    expect(html).toContain("account-approval");
  });

  it("renders the named signal, JSON payload field, and delivery action", async () => {
    const { SignalWaitCard } = await import("./dashboard.js");
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(SignalWaitCard, {
          wait: signalWait,
          payload: '{"approved":true}',
          canSignal: true,
          sending: false,
          onPayloadChange: () => undefined,
          onSend: () => undefined,
          inspectJob: () => undefined,
        }),
      ),
    );

    expect(html).toContain("account-approval");
    expect(html).toContain("approval-task · default · attempt 1");
    expect(html).toContain("Signal payload (JSON)");
    expect(html).toContain("Send signal");
    expect(html).toContain("View task");
    expect(html).toContain('aria-label="Signal account-approval for task signal-job"');
    expect(html).toContain('aria-label="Signal input for account-approval"');
  });
});
