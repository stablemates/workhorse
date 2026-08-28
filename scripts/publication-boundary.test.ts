import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const integrationAssetDirectory = "site/public/brand/integrations/";
const provenancePath = "docs/integration-brand-assets.md";

async function trackedPaths(): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "-z"], {
    encoding: "utf8",
  });
  return stdout.split("\0").filter(Boolean);
}

describe("the publication boundary", () => {
  it("keeps internal planning material out of the public tree", async () => {
    const paths = await trackedPaths();
    const inboundLinks: string[] = [];

    expect(paths).not.toContain("TODO.md");
    expect(paths.filter((relativePath) => relativePath.startsWith("docs/research/"))).toEqual([]);

    for (const relativePath of paths.filter((candidate) => candidate.endsWith(".md"))) {
      const contents = await readFile(relativePath, "utf8");
      if (/\]\([^)]*(?:TODO\.md|docs\/research\/)/.test(contents)) {
        inboundLinks.push(relativePath);
      }
    }
    expect(inboundLinks).toEqual([]);
  });

  it("records provenance and permitted use for every integration mark", async () => {
    const paths = await trackedPaths();
    const assets = paths
      .filter((path) => path.startsWith(integrationAssetDirectory) && path.endsWith(".svg"))
      .toSorted();
    const provenance = await readFile(provenancePath, "utf8");
    const records = provenance
      .split("\n")
      .filter((line) => line.startsWith(`| \`${integrationAssetDirectory}`));
    const recordedAssets = records
      .map((record) => record.match(/^\| `([^`]+)`\s+\|/)?.[1])
      .filter((asset): asset is string => asset !== undefined)
      .toSorted();

    expect(recordedAssets).toEqual(assets);
    for (const record of records) {
      expect(record).toMatch(/https:\/\//);
      expect(record).toMatch(/MIT|trademark/i);
      expect(record).toMatch(/identification/i);
      expect(record).toMatch(/`[0-9a-f]{64}` \|$/);
    }
  });
});
