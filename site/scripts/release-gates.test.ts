import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * `docs/release-gates.md` is the public summary of the six 1.0.0 gates of ADR 0056. Each gate
 * section must state its bar, its state, and the date of the last change of that state. The page
 * must state the rule for how it changes, and it must not name a private record by its location.
 * The term list cannot find a person or a host; `scripts/public-tree.test.ts` guards those. The
 * test lives here, not under `scripts/`, so that a change to the page selects no language lane of
 * CI.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pagePath = resolve(repositoryRoot, "docs/release-gates.md");

const gateStates = new Set(["Met", "Open", "Waived"]);

/** Terms that locate a private record. The name of the private repository is the first one. */
const privateTerms = ["workhorse-operations", "operations repository", "docs/reviews/"];

type GateSection = { number: number; body: string };

function gateSections(page: string): GateSection[] {
  return page
    .split(/^## /m)
    .slice(1)
    .flatMap((section) => {
      const number = /^Gate (\d+)\. /.exec(section)?.[1];
      return number === undefined ? [] : [{ number: Number(number), body: section }];
    });
}

/** True when the text is a YYYY-MM-DD date that exists in the calendar and is not in the future. */
function isPastCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().startsWith(text) &&
    date.getTime() <= Date.now()
  );
}

describe("the release gates page", async () => {
  const page = await readFile(pagePath, "utf8");
  const sections = gateSections(page);

  it("has one section for each of the six gates, in order", () => {
    expect(sections.map((section) => section.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it.each(sections)("states the bar, the state, and the date of Gate $number", ({ body }) => {
    expect(body, "bar").toMatch(/^- \*\*Bar:\*\* \S/m);
    const state = /^- \*\*State:\*\* (\S+)$/m.exec(body)?.[1];
    const date = /^- \*\*Last change:\*\* (\S+)$/m.exec(body)?.[1];
    expect(state !== undefined && gateStates.has(state), `state ${state}`).toBe(true);
    expect(date !== undefined && isPastCalendarDate(date), `date ${date}`).toBe(true);
  });

  it("states the rule for how the page changes", () => {
    const rule = page.split(/^## How this page changes\n/m)[1]?.replace(/\s+/g, " ");
    expect(rule).toContain(
      "A pull request that moves the state of a gate changes this page in the same pull request.",
    );
    expect(rule).toContain(
      "If the evidence is not in this repository, the next pull request changes the page.",
    );
  });

  it("names no private record by its location", () => {
    const lower = page.toLowerCase();
    expect(privateTerms.filter((term) => lower.includes(term))).toEqual([]);
  });
});
