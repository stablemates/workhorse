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

describe("documentation site guide coverage", () => {
  it("accounts for every guide with a site page or a tracked exclusion", async () => {
    const guideFiles = (await readdir(path.join(root, "docs/guides")))
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.slice(0, -3))
      .sort();
    const manifest = await readCoverage();
    const accountedFor = [
      ...Object.keys(manifest.pages),
      ...Object.keys(manifest.exclusions),
    ].sort();

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
});
