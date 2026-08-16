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
});
