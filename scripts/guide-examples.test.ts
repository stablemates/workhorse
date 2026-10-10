import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./packages.js";

// A guide opens with a concrete scenario whose queues, tasks, and tenants are invented. A reader
// who lands on the page cannot tell that from the prose alone, so the first scenario starts with
// a bold `**Example.**`. The site page that mirrors the guide carries the same marker. The CLAUDE.md
// section on writing documentation states the rule.

const marker = "**Example.**";

// Site pages that a guide maps to but that open with navigation rather than a scenario.
const pagesWithoutOpeningScenario = new Map([
  ["index", "mirrors the start-here index, which has no scenario"],
  ["operations", "opens with links to the pages that own each operations topic"],
]);

/** The first non-blank line under the page's first second-level heading. */
function firstSectionOpening(markdown: string): string | undefined {
  const lines = markdown.split("\n");
  const heading = lines.findIndex((line) => line.startsWith("## "));
  if (heading === -1) return undefined;
  return lines.slice(heading + 1).find((line) => line.trim() !== "");
}

const guidesDirectory = path.join(repositoryRoot, "docs/guides");
const guides = readdirSync(guidesDirectory)
  .filter((name) => name.endsWith(".md") && !name.startsWith("000-"))
  .toSorted();

const coverage = JSON.parse(
  readFileSync(path.join(repositoryRoot, "site/guide-coverage.json"), "utf8"),
) as { pages: Record<string, string> };
const sitePages = [...new Set(Object.values(coverage.pages))]
  .filter((page) => !pagesWithoutOpeningScenario.has(page))
  .toSorted();

describe("guide examples", () => {
  it.each(guides)("%s marks its opening scenario as an example", (name) => {
    const markdown = readFileSync(path.join(guidesDirectory, name), "utf8");
    expect(firstSectionOpening(markdown)?.slice(0, marker.length + 1)).toBe(`${marker} `);
  });

  it.each(sitePages)("site page %s marks its opening scenario as an example", (page) => {
    const markdown = readFileSync(
      path.join(repositoryRoot, "site/content/docs", `${page}.mdx`),
      "utf8",
    );
    expect(firstSectionOpening(markdown)?.slice(0, marker.length + 1)).toBe(`${marker} `);
  });

  it("exempts only site pages that a guide maps to", () => {
    const mapped = new Set(Object.values(coverage.pages));
    expect([...pagesWithoutOpeningScenario.keys()].filter((page) => !mapped.has(page))).toEqual([]);
  });
});
