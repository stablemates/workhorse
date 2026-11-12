import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  DashboardTaskRow,
  DashboardSignalWaitRow,
} from "@stablemates/workhorse-dashboard-server/wire";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

const signalWait: DashboardSignalWaitRow = {
  taskId: "signal-task",
  queue: "default",
  taskType: "approval-task",
  name: "account-approval",
  attempt: 1,
  createdAt: "2026-08-16T03:00:00.000Z",
  deadlineAt: "2026-08-17T03:00:00.000Z",
};

describe("dashboard signal waits", () => {
  it.each([
    { kind: "signal", color: "violet", label: "Waiting for signal: account-approval" },
    { kind: "human", color: "pink", label: "Waiting for decision: account-review" },
    { kind: "durable", color: "indigo", label: "Durable wait: retry-delay" },
  ])(
    "uses one $kind waiting indicator instead of also showing scheduled",
    async ({ kind, color, label }) => {
      const { TaskStatusIndicators } = await import("./components/task-list.js");
      const task = {
        state: "scheduled",
        signalWait:
          kind === "signal" ? { name: signalWait.name, deadlineAt: signalWait.deadlineAt } : null,
        humanWait:
          kind === "human"
            ? { name: "account-review", deadlineAt: signalWait.deadlineAt, context: null }
            : null,
        wait:
          kind === "durable"
            ? { name: "retry-delay", wakeAt: signalWait.deadlineAt, mode: "relative" }
            : null,
      } as DashboardTaskRow;
      const html = renderToStaticMarkup(
        createElement(MantineProvider, null, createElement(TaskStatusIndicators, { task })),
      );

      expect(html.match(/mantine-Badge-root/g)).toHaveLength(1);
      expect(html).toContain(`>${label}<`);
      expect(html).not.toContain('role="status"');
      expect(html).toContain(`--mantine-color-${color}-light`);
      expect(html).toContain(
        kind === "durable"
          ? ">Durable wait<"
          : `>Waiting for ${kind === "signal" ? "signal" : "decision"}<`,
      );
      expect(html).not.toContain(">Status: scheduled<");
    },
  );

  it("marks a task row as waiting for its named signal", async () => {
    const { TaskWaitBadge } = await import("./dashboard.js");
    const task = {
      state: "scheduled",
      wait: null,
      signalWait: { name: signalWait.name, deadlineAt: signalWait.deadlineAt },
    } as DashboardTaskRow;
    const html = renderToStaticMarkup(
      createElement(MantineProvider, null, createElement(TaskWaitBadge, { task })),
    );

    expect(html).toContain("Waiting for signal");
    expect(html).toContain("account-approval");
  });

  it("marks a task row as waiting for its named human decision", async () => {
    const { TaskWaitBadge } = await import("./dashboard.js");
    const task = {
      state: "active",
      wait: null,
      signalWait: null,
      humanWait: {
        name: "account-review",
        quickAction: null,
        deadlineAt: "2026-08-17T03:00:00.000Z",
      },
    } as DashboardTaskRow;
    const html = renderToStaticMarkup(
      createElement(MantineProvider, null, createElement(TaskWaitBadge, { task })),
    );

    expect(html).toContain("Waiting for decision");
    expect(html).toContain("account-review");
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
          inspectTask: () => undefined,
        }),
      ),
    );

    expect(html).toContain("account-approval");
    expect(html).toContain("approval-task · default · attempt 1");
    expect(html).toContain("Signal payload (JSON)");
    expect(html).toContain("Send signal");
    expect(html).toContain("View task");
    expect(html).toContain('aria-label="Signal account-approval for task signal-task"');
    expect(html).toContain('aria-label="Signal input for account-approval"');
  });
  it("tells the operator when a signal reaches a task or a wait that has ended", async () => {
    const { signalDeliveryNotice } = await import("./components/signal-task.js");

    expect(signalDeliveryNotice("approval", "delivered")).toEqual({
      title: "Signal delivered",
      message: "approval: delivered",
      tone: "success",
    });
    // send_signal_v2 answers stale for a terminal task that has no wait, and for a wait that ended.
    expect(signalDeliveryNotice("approval", "stale")).toEqual({
      title: "Signal not delivered",
      message: "approval: the task or its wait has ended. Workhorse did not deliver the signal.",
      tone: "neutral",
    });
    // A live task that has not reached the wait keeps its answer.
    expect(signalDeliveryNotice("approval", "not_waiting")).toEqual({
      title: "Signal unchanged",
      message: "approval: not_waiting",
      tone: "neutral",
    });
    for (const status of ["already_delivered", "duplicate", "not_found"] as const) {
      expect(signalDeliveryNotice("approval", status).title).toBe("Signal unchanged");
    }
  });
});
