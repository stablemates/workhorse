import { describe, expect, it } from "vitest";

import { sidebarMotion, sidebarSlide } from "./shell/sidebar-motion.js";

describe("sidebar slide", () => {
  it("starts the page at its old place and takes the full time for a full slide", () => {
    // Collapse: the page edge moves from 256px to 88px.
    expect(sidebarSlide(256, 88, null)).toEqual({
      offset: 168,
      durationMs: sidebarMotion.durationMs,
      distance: 168,
    });
    // Expand: the page edge moves back.
    expect(sidebarSlide(88, 256, null)).toEqual({
      offset: -168,
      durationMs: sidebarMotion.durationMs,
      distance: 168,
    });
  });

  it("turns around where the page shows and takes the share of the time that is left", () => {
    // A collapse is 70% done when the operator expands again: the page shows at 138.4px.
    const turn = sidebarSlide(88 + 168 * 0.3, 256, 168);
    expect(turn?.offset).toBeCloseTo(-117.6);
    expect(turn?.durationMs).toBeCloseTo(sidebarMotion.durationMs * 0.7);
    expect(turn?.distance).toBe(168);
  });

  it("does not slide when the place does not change", () => {
    expect(sidebarSlide(256, 256, null)).toBeNull();
    expect(sidebarSlide(256.3, 256, 168)).toBeNull();
  });
});
