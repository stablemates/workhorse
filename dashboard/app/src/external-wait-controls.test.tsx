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

describe("external wait deadline", () => {
  it("states an overdue deadline in text and assistive output", async () => {
    const { ExternalWaitDeadline } = await import("./external-wait-controls.js");
    const html = render(ExternalWaitDeadline, {
      deadline: "August 16 at 9:00 AM",
      overdue: true,
    });

    expect(html).toContain("Overdue · ");
    expect(html).toContain("Deadline August 16 at 9:00 AM");
    // The deadline is static text: it is not a live region and has no name on a paragraph.
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("aria-label=");
  });
});
