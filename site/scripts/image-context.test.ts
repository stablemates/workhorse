import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The site build writes these outputs, and `.gitignore` keeps them out of commits. A checkout still
// holds whatever an earlier local build wrote, so every one must stay out of the image's build
// context too; production once served twins of pages deleted months earlier (SM-855).
const repositoryRoot = resolve(import.meta.dirname, "../..");

async function patterns(file: string): Promise<string[]> {
  return (await readFile(resolve(repositoryRoot, file), "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

describe("the site image build context", () => {
  it("excludes every generated site output that git ignores", async () => {
    const [gitignore, dockerignore] = await Promise.all([
      patterns(".gitignore"),
      patterns(".dockerignore"),
    ]);
    const generated = gitignore
      .filter((pattern) => pattern.startsWith("/site/"))
      .map((pattern) => pattern.replace(/^\//, "").replace(/\/$/, ""));

    expect(generated.length).toBeGreaterThan(0);
    expect(generated.filter((path) => !dockerignore.includes(path))).toEqual([]);
    // `.gitignore` names `.source/` unanchored; the context needs it at any depth.
    expect(gitignore).toContain(".source/");
    expect(dockerignore).toContain("**/.source");
  });
});
