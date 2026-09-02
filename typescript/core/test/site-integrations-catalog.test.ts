import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");

interface Integration {
  slug: string;
  name: string;
  category: string;
  tier: "verified" | "documented";
  summary: string;
  boundary: string;
  package?: string;
  peer?: string;
  pinnedBy?: string;
  logo?: { light: string; dark: string };
  landingSnippet?: string;
  verifiedOn?: string;
}

interface Catalog {
  categories: { id: string; title: string; question: string }[];
  integrations: Integration[];
}

const readCatalog = async () =>
  JSON.parse(await readFile(path.join(root, "site/integrations.json"), "utf8")) as Catalog;

interface PackageManifest {
  name?: string;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const readManifest = async (directory: string) =>
  JSON.parse(await readFile(path.join(root, directory, "package.json"), "utf8")) as PackageManifest;

describe("documentation site integration catalog", () => {
  it("gives every entry a page and every page an entry", async () => {
    const catalog = await readCatalog();
    const meta = JSON.parse(
      await readFile(path.join(root, "site/content/docs/meta.json"), "utf8"),
    ) as { pages: string[] };

    await Promise.all(
      catalog.integrations.map((entry) =>
        expect(
          readFile(path.join(root, "site/content/docs", `${entry.slug}.mdx`), "utf8"),
        ).resolves.toEqual(expect.any(String)),
      ),
    );

    // The catalog is the only source for this sidebar group, so listing a page
    // under the separator would put an integration in two places at once.
    const start = meta.pages.indexOf("---Integrations---");
    expect(start).toBeGreaterThan(-1);
    expect(meta.pages[start + 1]).toMatch(/^---.+---$/);
  });

  it("keeps categories ordered, named, and populated", async () => {
    const catalog = await readCatalog();
    const ids = catalog.categories.map((category) => category.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const category of catalog.categories) {
      expect(category.title.trim()).not.toBe("");
      expect(category.question).toMatch(/\?$/);
      expect(catalog.integrations.filter((entry) => entry.category === category.id)).not.toEqual(
        [],
      );
    }
    for (const entry of catalog.integrations) {
      expect(ids).toContain(entry.category);
      expect(entry.summary.trim()).not.toBe("");
      expect(entry.boundary.trim()).not.toBe("");
    }
  });

  it("backs every verified entry with a package this repository tests", async () => {
    const catalog = await readCatalog();
    const workspace = await readdir(path.join(root, "typescript"), { withFileTypes: true });
    const manifests = new Map<string, PackageManifest | undefined>(
      await Promise.all(
        workspace
          .filter((entry) => entry.isDirectory())
          .map(
            async (entry): Promise<[string, PackageManifest | undefined]> => [
              `typescript/${entry.name}`,
              await readManifest(`typescript/${entry.name}`).catch(() => undefined),
            ],
          ),
      ),
    );
    const byName = new Map(
      [...manifests].flatMap(([, manifest]) => (manifest?.name ? [[manifest.name, manifest]] : [])),
    );

    for (const entry of catalog.integrations.filter((one) => one.tier === "verified")) {
      const own = byName.get(entry.package ?? "");
      expect(own, `${entry.slug} names an unknown package`).toBeDefined();
      expect(own?.peerDependencies?.[entry.peer ?? ""]).toEqual(expect.any(String));

      const pinning = manifests.get(entry.pinnedBy ?? "");
      expect(pinning, `${entry.slug} names an unknown pinnedBy`).toBeDefined();
      expect(pinning?.devDependencies?.[entry.peer ?? ""]).toEqual(expect.any(String));

      // Continuous integration re-checks a verified entry on every change. A
      // date beside it would claim less than the tier already proves.
      expect(entry.verifiedOn).toBeUndefined();
    }
  });

  it("dates every documented entry and gives it no package", async () => {
    const catalog = await readCatalog();

    for (const entry of catalog.integrations.filter((one) => one.tier === "documented")) {
      expect(entry.package).toBeUndefined();
      expect(entry.peer).toBeUndefined();
      expect(entry.pinnedBy).toBeUndefined();
      expect(entry.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Date.parse(entry.verifiedOn ?? "")).toBeLessThanOrEqual(Date.now());
    }
  });

  it("points every logo and landing snippet at something that exists", async () => {
    const catalog = await readCatalog();
    const marks = new Set(await readdir(path.join(root, "site/public/brand/integrations")));
    const snippets = await readFile(path.join(root, "site/lib/landing-snippets.ts"), "utf8");

    const missingMarks = catalog.integrations.flatMap((entry) =>
      [entry.logo?.light, entry.logo?.dark]
        .filter((variant) => variant !== undefined)
        .filter((variant) => !marks.has(`${variant}.svg`))
        .map((variant) => `${entry.slug} -> ${variant}.svg`),
    );
    const missingSnippets = catalog.integrations
      .filter((entry) => entry.landingSnippet !== undefined)
      .filter((entry) => !snippets.includes(`${entry.landingSnippet}:`))
      .map((entry) => `${entry.slug} -> ${entry.landingSnippet}`);

    expect(missingMarks).toEqual([]);
    expect(missingSnippets).toEqual([]);
  });

  it("keeps the index page's tier vocabulary and the catalog in agreement", async () => {
    const catalog = await readCatalog();
    const page = await readFile(path.join(root, "site/content/docs/integrations.mdx"), "utf8");

    for (const tier of new Set(catalog.integrations.map((entry) => entry.tier))) {
      const heading = `${tier[0]?.toUpperCase()}${tier.slice(1)}`;
      expect(page, `the index page never defines the ${tier} tier`).toContain(`**${heading}.**`);
    }
    // The catalog renders through this tag. Losing it empties the page.
    expect(page).toContain("<IntegrationCatalog />");
  });
});
