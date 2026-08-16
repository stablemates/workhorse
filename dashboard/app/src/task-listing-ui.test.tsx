import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

function render(component: unknown, props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(component as never, props)),
  );
}

describe("task listing identity", () => {
  it("keeps the display name on one line and exposes the full name as its title", async () => {
    const { TaskName } = await import("./dashboard.js");
    const html = render(TaskName, {
      type: "billing.customer.invoice.reconciliation.requested",
      queue: "billing",
    });

    expect(html).toContain('title="customer.invoice.reconciliation.requested"');
    expect(html).toContain("width:180px");
    expect(html).toContain("white-space:nowrap");
    expect(html).toContain("text-overflow:ellipsis");
  });

  it("renders tags independently and gives every visible tag a title", async () => {
    const { TaskTags } = await import("./dashboard.js");
    const html = render(TaskTags, {
      tags: ["billing", "weekly", "durable-checkpoint"],
    });

    expect(html).toContain('title="billing"');
    expect(html).toContain('title="weekly"');
    expect(html).not.toContain("durable-checkpoint");
  });

  it("uses a named button to open task details from the table", async () => {
    const { TaskOpenButton } = await import("./task-table-ui.js");
    const html = render(TaskOpenButton, {
      jobId: "job-123",
      taskType: "billing.invoice",
      onOpen: () => undefined,
      children: "Invoice",
    });

    expect(html).toContain("<button");
    expect(html).toContain('id="task-open-job-123"');
    expect(html).toContain('aria-label="View task billing.invoice, job-123"');
  });

  it("announces task state without relying on badge color", async () => {
    const { StatusBadge } = await import("./status-badge.js");
    const html = render(StatusBadge, { state: "failed" });

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Status: failed"');
  });
});
