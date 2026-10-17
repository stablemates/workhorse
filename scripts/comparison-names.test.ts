import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./packages.js";

// ADR 0104 permits the name of a compared product in two places only: the comparison data in
// `site/comparisons.json` and the pages under `site/content/docs/compare/`. Benchmark results
// stay private, and a name elsewhere in the repository is where such a result starts to leak.
// This check reads the names from the data file, so a product added there is guarded at once.
//
// A name matches as a whole word and with its own capitals, because several names are also common
// words in lower case. A hyphen ends a word, so "Example Queue-based" names Example Queue.

interface Product {
  name: string;
  aliases?: string[];
}

/** Paths that may name a compared product, with the reason for each. */
const permittedPaths: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /^site\/comparisons\.json$/, reason: "The comparison data (ADR 0104)." },
  { pattern: /^site\/content\/docs\/compare\//, reason: "The comparison pages (ADR 0104)." },
  { pattern: /^docs\/decisions\//, reason: "Decision records keep the words of their time." },
  {
    pattern: /^(?:.+\/)?CHANGELOG\.md$/,
    reason: "Release notes describe released versions and do not change after a release.",
  },
  {
    pattern: /^site\/content\/docs\/active-job\.mdx$/,
    reason: "The Active Job adapter replaces the Rails queue backends by name.",
  },
  {
    pattern: /^site\/content\/docs\/django\.mdx$/,
    reason: "The Django page names the task API it is compatible with.",
  },
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A case-sensitive whole-word pattern for each name and alias. */
function namePatterns(products: readonly Product[]): { name: string; pattern: RegExp }[] {
  return products.flatMap((product) =>
    [product.name, ...(product.aliases ?? [])].map((name) => ({
      name,
      pattern: new RegExp(String.raw`(?<![\w.])${escape(name)}(?!\w)`),
    })),
  );
}

/** Each line of `files` that names a product outside the permitted paths. */
function violations(
  files: readonly { path: string; text: string }[],
  products: readonly Product[],
): string[] {
  const patterns = namePatterns(products);
  const found: string[] = [];
  for (const file of files) {
    if (permittedPaths.some(({ pattern }) => pattern.test(file.path))) continue;
    file.text.split("\n").forEach((line, index) => {
      for (const { name, pattern } of patterns) {
        if (pattern.test(line)) found.push(`${file.path}:${index + 1} names ${name}`);
      }
    });
  }
  return found;
}

const products = (
  JSON.parse(readFileSync(path.join(repositoryRoot, "site/comparisons.json"), "utf8")) as {
    products: Product[];
  }
).products;

describe("compared product names", () => {
  it("fails on a name outside the permitted paths", () => {
    const sample = [{ name: "Example Queue", aliases: ["example-queue"] }];
    expect(
      violations(
        [
          { path: "docs/guides/010-tasks.md", text: "Unlike Example Queue, Workhorse..." },
          { path: "typescript/core/src/a.ts", text: 'import "example-queue";' },
          { path: "docs/guides/030-workers.md", text: "Example Queue-based results" },
          { path: "README.md", text: "Workhorse-vs-Example Queue" },
          { path: "site/content/docs/compare/example-queue.mdx", text: "Example Queue" },
          { path: "docs/decisions/0001-x.md", text: "Example Queue" },
          { path: "docs/guides/020-leases.md", text: "an example queue" },
        ],
        sample,
      ),
    ).toEqual([
      "docs/guides/010-tasks.md:1 names Example Queue",
      "typescript/core/src/a.ts:1 names example-queue",
      "docs/guides/030-workers.md:1 names Example Queue",
      "README.md:1 names Example Queue",
    ]);
  });

  it("finds no compared product name outside the permitted paths", () => {
    expect(products.length).toBeGreaterThan(0);
    const paths = execFileSync("git", ["ls-files", "-z"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter((file) => file !== "");
    const files = paths.flatMap((file) => {
      let text: string;
      try {
        text = readFileSync(path.join(repositoryRoot, file), "utf8");
      } catch {
        // A file deleted in the working tree is not content anyone ships.
        return [];
      }
      // Binary files hold no prose.
      return text.includes("\0") ? [] : [{ path: file, text }];
    });
    expect(violations(files, products)).toEqual([]);
  });
});
