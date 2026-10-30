import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FONT_KEYS, previewCssVariables } from "./components/graphical/lib/theme-model.js";
import { dashboardThemeDocument } from "./theme-document.js";

/** The source of a module of the app, read from disk. */
function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("dashboard theme document", () => {
  it("ends each font stack of the Graphical controls with the Geist fallback", () => {
    const vars = new Map(
      Object.entries(previewCssVariables(dashboardThemeDocument.theme, "light")),
    );
    for (const key of FONT_KEYS) {
      expect(vars.get(`--font-${key}`)).toBe(
        '"Timeless Grotesk", "Geist Variable", ui-sans-serif, system-ui, sans-serif',
      );
    }
  });

  it("is the document that the Graphical provider and Mantine read", () => {
    expect(source("./theme.tsx")).toContain("<GraphicalProvider document={dashboardThemeDocument}");
    expect(source("./mantine-theme.ts")).toContain(
      "const definition = dashboardThemeDocument.theme;",
    );
  });
});
