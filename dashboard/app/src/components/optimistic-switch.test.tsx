import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OptimisticSwitch, shownSwitchPosition } from "./optimistic-switch.js";

describe("optimistic switch", () => {
  it("shows the requested position only while the change runs", () => {
    expect(shownSwitchPosition({ checked: true, pending: true, requested: false })).toBe(false);
    // A failed change ends with the old server value, so the switch moves back.
    expect(shownSwitchPosition({ checked: true, pending: false, requested: false })).toBe(true);
    // A successful change ends with the new server value.
    expect(shownSwitchPosition({ checked: false, pending: false, requested: false })).toBe(false);
    expect(shownSwitchPosition({ checked: true, pending: true, requested: null })).toBe(true);
  });

  it("marks a running change busy without the disabled state", () => {
    const html = renderToStaticMarkup(
      createElement(OptimisticSwitch, {
        checked: true,
        pending: true,
        "aria-label": "Pause billing",
        onCheckedChange: () => undefined,
      }),
    );
    expect(html).toContain('aria-label="Pause billing"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-readonly="true"');
    expect(html).not.toContain("data-disabled");
    expect(html).toContain("dashboard-switch");
  });
});
