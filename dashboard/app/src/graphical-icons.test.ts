import * as freePack from "@hugeicons/core-free-icons";
import { describe, expect, it } from "vitest";

import { HUGEICONS_NAMES } from "./components/graphical/lib/hugeicons-names.js";
import { theme } from "./components/graphical/theme.js";
import * as catalog from "./hugeicons-catalog.js";

describe("Hugeicons for the Graphical components", () => {
  it("selects the outlined variant of the free pack", () => {
    expect(theme.theme.iconFamily).toBe("Hugeicons");
    expect(theme.theme.hugeiconsVariant).toBe("stroke-rounded");
    expect(theme.theme.iconStyle).toBe("outlined");
  });

  it("finds each glyph that the components name in the free pack", () => {
    const missing = Object.values(HUGEICONS_NAMES).filter((name) => !(name in freePack));
    expect(missing).toEqual([]);
  });

  it("loads exactly the glyphs that the components name", () => {
    const named = [...new Set(Object.values(HUGEICONS_NAMES))].toSorted();
    expect(Object.keys(catalog).toSorted()).toEqual(named);
  });
});
