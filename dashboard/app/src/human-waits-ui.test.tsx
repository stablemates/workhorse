import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

function render(component: unknown, props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(component as never, props)),
  );
}

describe("human decision controls", () => {
  it("offers approval without requiring JSON while keeping custom results available", async () => {
    const { HumanDecisionControls } = await import("./dashboard.js");
    const html = render(HumanDecisionControls, {
      result: "",
      ariaLabel: "Decision for refund-approval",
      quickAction: { label: "Approve" },
      canComplete: true,
      confirming: false,
      completing: false,
      onQuickAction: vi.fn<() => void>(),
      onResultChange: vi.fn<(value: string) => void>(),
      onReview: vi.fn<() => void>(),
      onComplete: vi.fn<() => void>(),
      onKeepEditing: vi.fn<() => void>(),
    });

    expect(html).toContain(">Approve<");
    expect(html).toContain("Provide a custom JSON result");
    expect(html).toContain("Result (JSON)");
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Decision for refund-approval"');
  });

  it("states an overdue deadline in text and assistive output", async () => {
    const { ExternalWaitDeadline } = await import("./external-wait-controls.js");
    const html = render(ExternalWaitDeadline, {
      deadline: "August 16 at 9:00 AM",
      overdue: true,
    });

    expect(html).toContain("Overdue · ");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Overdue. Deadline August 16 at 9:00 AM"');
  });

  it("confirms an application-defined quick action before completion", async () => {
    const { HumanDecisionControls } = await import("./dashboard.js");
    const html = render(HumanDecisionControls, {
      result: '{\n  "approved": true\n}',
      ariaLabel: "Decision for refund-approval",
      quickAction: { label: "Approve" },
      canComplete: true,
      confirming: true,
      completing: false,
      onQuickAction: vi.fn<() => void>(),
      onResultChange: vi.fn<(value: string) => void>(),
      onReview: vi.fn<() => void>(),
      onComplete: vi.fn<() => void>(),
      onKeepEditing: vi.fn<() => void>(),
    });

    expect(html).toContain("Confirm decision");
    expect(html).toContain("The first accepted result resumes the handler");
  });

  it("does not invent an approval action for a generic human decision", async () => {
    const { HumanDecisionControls } = await import("./dashboard.js");
    const html = render(HumanDecisionControls, {
      result: "",
      ariaLabel: "Decision for generic-review",
      quickAction: null,
      canComplete: true,
      confirming: false,
      completing: false,
      onQuickAction: vi.fn<() => void>(),
      onResultChange: vi.fn<(value: string) => void>(),
      onReview: vi.fn<() => void>(),
      onComplete: vi.fn<() => void>(),
      onKeepEditing: vi.fn<() => void>(),
    });

    expect(html).not.toContain(">Approve<");
    expect(html).toContain("Provide a custom JSON result");
  });
});
