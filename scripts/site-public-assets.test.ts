import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "./packages.js";
import {
  imagePattern,
  markdownImageUrls,
  publicImages,
  siteImageUses,
} from "./site-public-assets.js";

// The site build copies all of site/public into the site image, so a committed file there that
// nothing uses still ships (SM-1673). Generated files in site/public are ignored by git, so only the
// committed files are held to this rule.
function committedPublicFiles(): string[] {
  return execFileSync("git", ["ls-files", "site/public"], { cwd: repositoryRoot, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((file) => file.slice("site/public/".length))
    .toSorted();
}

function repositoryMarkdown(): Promise<string> {
  const files = execFileSync("git", ["ls-files", "*.md"], { cwd: repositoryRoot, encoding: "utf8" })
    .split("\n")
    .filter((file) => file && !file.startsWith("site/"));
  return Promise.all(files.map((file) => readFile(path.join(repositoryRoot, file), "utf8"))).then(
    (texts) => texts.join("\n"),
  );
}

describe("site/public", () => {
  it("commits only images", () => {
    expect(committedPublicFiles().filter((file) => !imagePattern.test(file))).toEqual([]);
  });

  it("commits no image that neither the site nor the repository Markdown uses", async () => {
    const [used, markdown, images] = await Promise.all([
      siteImageUses(),
      repositoryMarkdown(),
      publicImages(),
    ]);
    const committed = new Set(committedPublicFiles());
    const unused = images.filter(
      (image) =>
        committed.has(image) && !used.has(image) && !markdown.includes(`site/public/${image}`),
    );
    expect(unused, "Remove these files, or use them on a page.").toEqual([]);
  });

  // A registry renders a package README without the repository, so the README loads its images
  // from the public site. The prune step must keep each of them (SM-1787).
  it("keeps every image that repository Markdown loads from the public site", async () => {
    const [used, markdown] = await Promise.all([siteImageUses(), repositoryMarkdown()]);
    const loaded = [...markdownImageUrls(markdown)];
    expect(loaded).toContain("diagrams/readme-overview-dark.png");
    expect(loaded.filter((image) => !used.has(image))).toEqual([]);
  });

  // The site logo inlines its SVGs through a relative import, so it can follow currentColor. The
  // prune step must keep them, because the nginx smoke check requests the mark.
  it("counts an image that a site module imports by a relative path", async () => {
    const used = await siteImageUses();
    expect(used).toContain("brand/workhorse-mark.svg");
    expect(used).toContain("brand/workhorse-wordmark.svg");
  });

  it("names no image that does not exist", async () => {
    const images = new Set(await publicImages());
    const missing = [...(await siteImageUses())].filter((image) => !images.has(image));
    expect(missing, "Run `pnpm diagrams:generate`, or correct the name.").toEqual([]);
  });

  it("keeps the diagram SVGs out of the published directory", async () => {
    const diagrams = await readdir(path.join(repositoryRoot, "site/public/diagrams"));
    expect(diagrams.filter((file) => !file.endsWith(".png"))).toEqual([]);
  });

  it("removes the images that the site does not use before the site image copies its build", async () => {
    const dockerfile = await readFile(path.join(repositoryRoot, "Dockerfile.site"), "utf8");
    const prune = dockerfile.indexOf("tsx scripts/site-public-assets.ts --prune site/dist/client");
    const build = dockerfile.indexOf("pnpm docs:build");
    const copy = dockerfile.indexOf("COPY --from=build /workhorse/site/dist/client/");
    expect(build).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(build);
    expect(copy).toBeGreaterThan(prune);
  });
});

// The dashboard build copies all of dashboard/app/src/assets into the library build and into the
// facade's development sources, and npm publishes both copies. A file there that no module names
// therefore ships twice in @stablemates/workhorse-dashboard (SM-1673).
describe("dashboard/app/src/assets", () => {
  it("holds only files that a dashboard module names", async () => {
    const directory = path.join(repositoryRoot, "dashboard/app/src/assets");
    const assets = await readdir(directory);
    const modules = execFileSync("git", ["ls-files", "dashboard/app/src"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter((file) => /\.(tsx?|css)$/.test(file) && !/\.test\.tsx?$/.test(file));
    const sources = (
      await Promise.all(modules.map((file) => readFile(path.join(repositoryRoot, file), "utf8")))
    ).join("\n");
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.filter((asset) => !sources.includes(`assets/${asset}`))).toEqual([]);
  });
});
