import { access, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Both images install dependencies from the manifests alone, before copying the checkout, so the
// install layer survives a commit that changes no dependency (SM-858). A workspace package missing
// from that list fails the frozen install with an error that does not name the Dockerfile.
const repositoryRoot = resolve(import.meta.dirname, "..");

async function workspaceManifests(): Promise<string[]> {
  const workspace = await readFile(resolve(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  const globs = [...workspace.matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((match) => match[1]!);
  const directories: string[] = [];
  for (const glob of globs) {
    if (!glob.endsWith("/*")) {
      directories.push(glob);
      continue;
    }
    const parent = glob.slice(0, -2);
    const entries = await readdir(resolve(repositoryRoot, parent), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) directories.push(`${parent}/${entry.name}`);
    }
  }
  const manifests: string[] = [];
  for (const directory of directories) {
    const manifest = `${directory}/package.json`;
    const exists = await access(resolve(repositoryRoot, manifest)).then(
      () => true,
      () => false,
    );
    if (exists) manifests.push(manifest);
  }
  return manifests.toSorted();
}

describe.each(["Dockerfile", "Dockerfile.site"])("%s", (dockerfile) => {
  it("installs from every workspace manifest before it copies the checkout", async () => {
    const [source, manifests] = await Promise.all([
      readFile(resolve(repositoryRoot, dockerfile), "utf8"),
      workspaceManifests(),
    ]);
    const checkout = source.indexOf("\nCOPY . .\n");
    const install = source.indexOf("\nRUN pnpm install --frozen-lockfile\n");
    expect(checkout).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(checkout);

    expect(manifests.length).toBeGreaterThan(10);
    const missing = manifests.filter((manifest) => {
      const copy = source.indexOf(`\nCOPY ${manifest} ${manifest.replace(/package\.json$/, "")}\n`);
      return copy === -1 || copy > install;
    });
    expect(missing).toEqual([]);
    expect(
      source.indexOf("\nCOPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./\n"),
    ).toBeLessThan(install);
  });
});
