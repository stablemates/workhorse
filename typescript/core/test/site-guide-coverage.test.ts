import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");

type GuideCoverage = {
  pages: Record<string, string>;
  exclusions: Record<string, { issue: string; reason: string }>;
};

const readCoverage = async () =>
  JSON.parse(await readFile(path.join(root, "site/guide-coverage.json"), "utf8")) as GuideCoverage;

function inlineIdentifiers(markdown: string): string[] {
  const withoutCodeBlocks = markdown.replace(/```[\s\S]*?```/g, "");
  const literals = new Set(["DELETE", "Origin", "POST", "_FILE"]);
  return [...withoutCodeBlocks.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1]!)
    .filter((identifier) => {
      if (identifier.endsWith(".md") || literals.has(identifier)) return false;
      const name = identifier.replace(/\([^)]*\)$/, "");
      return (
        /^@[-\w]+\/[.\w-]+$/.test(name) ||
        /^\*?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(name) ||
        /^[A-Z_][A-Z0-9_]*$/.test(name) ||
        /^[A-Z][A-Za-z0-9]*$/.test(name) ||
        /^[a-z]+(?:[A-Z][A-Za-z0-9]*)+$/.test(name) ||
        /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name)
      );
    });
}

describe("documentation site guide coverage", () => {
  it("accounts for every guide with a site page or a tracked exclusion", async () => {
    const guideFiles = (await readdir(path.join(root, "docs/guides")))
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.slice(0, -3))
      .toSorted();
    const manifest = await readCoverage();
    const accountedFor = [
      ...Object.keys(manifest.pages),
      ...Object.keys(manifest.exclusions),
    ].toSorted();

    expect(accountedFor).toEqual(guideFiles);
    expect(new Set(accountedFor).size).toBe(accountedFor.length);
  });

  it("points mappings at real site pages and exclusions at tracked work", async () => {
    const manifest = await readCoverage();

    await Promise.all(
      Object.values(manifest.pages).map((page) =>
        expect(
          readFile(path.join(root, "site/content/docs", `${page}.mdx`), "utf8"),
        ).resolves.toEqual(expect.any(String)),
      ),
    );
    for (const exclusion of Object.values(manifest.exclusions)) {
      expect(exclusion.issue).toMatch(/^WOR-\d+$/);
      expect(exclusion.reason.trim()).not.toBe("");
    }
  });

  it("keeps each guide's identifiers in its mapped site page", async () => {
    const manifest = await readCoverage();
    const missingByGuide: Record<string, string[]> = {};

    for (const [guide, page] of Object.entries(manifest.pages)) {
      const [guideContents, pageContents] = await Promise.all([
        readFile(path.join(root, "docs/guides", `${guide}.md`), "utf8"),
        readFile(path.join(root, "site/content/docs", `${page}.mdx`), "utf8"),
      ]);
      const missing = [...new Set(inlineIdentifiers(guideContents))].filter(
        (identifier) => !pageContents.includes(identifier),
      );
      if (missing.length > 0) missingByGuide[`${guide} -> ${page}.mdx`] = missing;
    }
    expect(missingByGuide).toEqual({});
  });

  it("keeps corrected lifecycle claims aligned across source and site documentation", async () => {
    const files = await Promise.all(
      [
        "docs/architecture.md",
        "docs/guides/010-jobs-and-state.md",
        "docs/guides/140-deadlines-and-timeouts.md",
        "docs/guides/340-redrive.md",
        "site/content/docs/concepts.mdx",
        "site/content/docs/dead-letters.mdx",
        "site/content/docs/deadlines.mdx",
        "site/content/docs/compatibility.mdx",
      ].map((file) => readFile(path.join(root, file), "utf8")),
    );
    const combined = files.join("\n");

    expect(files[0]).toContain("Schema version 1 stores");
    // The claim guarded here is the storage shape, not the number. Schema version 2 exists as a
    // migration and these pages may name it; what must not come back is a second lifecycle design
    // presented as what a later schema version stores.
    expect(combined).not.toMatch(/schema version (?!1\b)\d+ stores|exactly as fast/i);
    expect(combined).not.toContain("Before a mutation, the client reads");
    expect(combined).not.toContain("Insert-only identity, routing, payload");
    expect(files[1]).toContain("pending [keyed debounce]");
    expect(files[4]).toContain("pending [keyed debounce]");
    expect(files[2]).toContain("calls `expire_owned_v1`");
    expect(files[6]).toContain("calls `expire_owned_v1`");
    // Compatibility used to name the TypeScript entrypoint alone, which read as a TypeScript-only
    // instruction on a page three SDKs share. It now names all three, so what this holds is the
    // claim rather than the spelling: the page still tells a reader to assert before a process
    // works. support-matrix.test.ts holds the three entrypoint names.
    expect(files[7]).toContain("Assert compatibility when a process starts");
  });
});
