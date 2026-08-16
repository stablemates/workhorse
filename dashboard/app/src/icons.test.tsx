import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as icons from "./icons.js";
import { iconSize, iconStroke, type DashboardIcon } from "./icons.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * The icon module is the dashboard's single seam onto an icon vendor. These tests hold that seam
 * shut: every icon it advertises has to draw something, and no screen may reach past it to the
 * vendor. Without the second test the module is only a convention, and one direct import in a new
 * screen quietly restores the per-call-site coupling this module exists to remove.
 */

const iconComponents = Object.entries(icons).filter(
  (entry): entry is [string, DashboardIcon] => typeof entry[1] === "function",
);

describe("dashboard icon module", () => {
  it("exports every icon the dashboard draws", () => {
    // A floor rather than an exact count, so adding an icon does not fail this test while
    // deleting the module's contents wholesale does.
    expect(iconComponents.length).toBeGreaterThanOrEqual(24);
  });

  it.each(iconComponents)("renders %s as an svg", (_name, Icon) => {
    const markup = renderToStaticMarkup(createElement(Icon));
    expect(markup).toContain("<svg");
    // An icon that renders an empty frame passes a "did it render" check while showing nothing,
    // so require actual drawing instructions inside it.
    expect(markup).toMatch(/<(path|circle|rect|line|polyline|polygon|ellipse)\b/);
  });

  it("applies the named size and stroke tokens", () => {
    const markup = renderToStaticMarkup(
      createElement(icons.CheckCircleIcon, { size: iconSize.navigation, weight: "bold" }),
    );
    expect(markup).toContain(`width="${iconSize.navigation}"`);
    expect(markup).toContain(`height="${iconSize.navigation}"`);
    expect(markup).toContain(`stroke-width="${iconStroke.bold}"`);
  });

  it("defaults to the menu size and the regular stroke", () => {
    const markup = renderToStaticMarkup(createElement(icons.InfoIcon));
    expect(markup).toContain(`width="${iconSize.menu}"`);
    expect(markup).toContain(`stroke-width="${iconStroke.regular}"`);
  });

  it("passes presentation attributes through to the svg", () => {
    const markup = renderToStaticMarkup(
      createElement(icons.WarningIcon, { color: "red", "aria-hidden": true }),
    );
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("red");
  });

  // This file names both packages in its own assertions, so scanning it would always report a
  // match. The module under test and this test are the two files allowed to name a vendor.
  const scannedSources = readdirSync(sourceDirectory).filter(
    (file) =>
      (file.endsWith(".ts") || file.endsWith(".tsx")) &&
      file !== "icons.tsx" &&
      file !== "icons.test.tsx",
  );

  it("is the only module that imports an icon package", () => {
    const iconPackage = /from\s+["'](@hugeicons\/[^"']+|@phosphor-icons\/[^"']+)["']/;
    const offenders = scannedSources.filter((file) =>
      iconPackage.test(readFileSync(join(sourceDirectory, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("has removed the previous icon library from the dashboard source", () => {
    const offenders = scannedSources.filter((file) =>
      readFileSync(join(sourceDirectory, file), "utf8").includes("@phosphor-icons"),
    );
    expect(offenders).toEqual([]);
  });
});
