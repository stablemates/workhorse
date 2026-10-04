import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./packages.js";

// A reader who opens an example should learn what it shows and where the documentation explains
// it. Every example source file therefore opens with a comment that describes it and links to the
// published page that owns it. The landing-page snippet files link to the site root.
const exampleDirectories = [
  "go/examples",
  "python/examples",
  "ruby/examples",
  "rust/examples",
  "typescript/examples",
  "typescript/adapter-conformance/examples",
];

const commentPrefixes: Record<string, string> = {
  ".go": "//",
  ".rb": "#",
  ".rs": "//",
  ".ts": "//",
  ".mjs": "//",
  ".sql": "--",
};

const siteLink = /https:\/\/workhorse\.run(?:\/docs(?:\/([a-z0-9-]+))?)?(?=[\s.,)]|$)/g;

function isExample(relativePath: string): boolean {
  const extension = path.extname(relativePath);
  if (!(extension in commentPrefixes) && extension !== ".py") return false;
  const name = path.basename(relativePath);
  if (name.endsWith("_test.go") || name.startsWith("test_")) return false;
  if (/\.(?:test|spec)\.ts$/.test(name)) return false;
  // sqlc writes these files, and regenerating them would discard a header. sqlc also copies a
  // leading comment in queries.sql into the first generated query, so the recipe's README carries
  // that file's description and link instead.
  if (relativePath === path.join("go", "examples", "sqlc", "queries.sql")) return false;
  return !relativePath.split(path.sep).includes("generated");
}

/** The comment a file opens with, after the preamble its language requires first. */
function leadingComment(source: string, extension: string): string[] {
  const lines = source.split("\n");
  if (extension === ".py") {
    const first = lines[0]?.trimStart() ?? "";
    if (!first.startsWith('"""')) return [];
    const body = source.slice(source.indexOf('"""') + 3);
    const end = body.indexOf('"""');
    return end === -1 ? [] : body.slice(0, end).split("\n");
  }
  const prefix = commentPrefixes[extension]!;
  const comment: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" || line.startsWith("# frozen_string_literal:")) {
      if (comment.length === 0) continue;
      break;
    }
    if (!line.startsWith(prefix)) break;
    comment.push(line.slice(prefix.length).replace(/^[!/]/, ""));
  }
  return comment;
}

function headerErrors(file: string, source: string, pages: ReadonlySet<string>): string[] {
  const comment = leadingComment(source, path.extname(file));
  if (comment.length === 0) return [`${file} does not open with a comment that describes it`];
  const text = comment.join("\n");
  const links = [...text.matchAll(siteLink)];
  if (links.length === 0) return [`${file} header links to no https://workhorse.run page`];
  const errors = links
    .map((link) => link[1])
    .filter((page): page is string => page !== undefined && !pages.has(page))
    .map((page) => `${file} header links to missing page /docs/${page}`);
  if (text.replace(siteLink, "").replace(/[\s.,:()-]/g, "").length < 12) {
    errors.push(`${file} header has a link but does not say what the example shows`);
  }
  return errors;
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", "target", "dist", "__pycache__"].includes(entry.name)) {
        files.push(...(await listFiles(fullPath)));
      }
    } else files.push(fullPath);
  }
  return files;
}

async function sitePages(): Promise<Set<string>> {
  const entries = await readdir(path.join(repositoryRoot, "site/content/docs"));
  return new Set(entries.filter((name) => name.endsWith(".mdx")).map((name) => name.slice(0, -4)));
}

describe("example headers", () => {
  it("opens every example with a description and a link to its documentation page", async () => {
    const pages = await sitePages();
    const errors: string[] = [];
    let checked = 0;
    for (const directory of exampleDirectories) {
      const root = path.join(repositoryRoot, directory);
      if (!existsSync(root)) continue;
      for (const file of await listFiles(root)) {
        const relative = path.relative(repositoryRoot, file);
        if (!isExample(relative)) continue;
        checked += 1;
        errors.push(...headerErrors(relative, await readFile(file, "utf8"), pages));
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  it("reads the header after each language's preamble", () => {
    const pages = new Set(["quickstart"]);
    const link = "https://workhorse.run/docs/quickstart";
    expect(
      headerErrors(
        "a.rb",
        `# frozen_string_literal: true\n\n# Runs the quickstart.\n# ${link}\nrequire "pg"\n`,
        pages,
      ),
    ).toEqual([]);
    expect(headerErrors("a.py", `"""Runs the quickstart.\n\n${link}\n"""\n`, pages)).toEqual([]);
    expect(headerErrors("a.rs", `//! Runs the quickstart.\n//! ${link}\nuse x;\n`, pages)).toEqual(
      [],
    );
    expect(
      headerErrors("a.go", `// Runs the quickstart.\n// ${link}\npackage main\n`, pages),
    ).toEqual([]);
  });

  it("rejects a missing header, a missing link, a bare link, and a missing page", () => {
    const pages = new Set(["quickstart"]);
    expect(headerErrors("a.ts", 'import x from "x";\n', pages)).toEqual([
      "a.ts does not open with a comment that describes it",
    ]);
    expect(headerErrors("a.ts", "// Runs the quickstart program end to end.\n", pages)).toEqual([
      "a.ts header links to no https://workhorse.run page",
    ]);
    expect(headerErrors("a.ts", "// https://workhorse.run/docs/quickstart\n", pages)).toEqual([
      "a.ts header has a link but does not say what the example shows",
    ]);
    expect(
      headerErrors(
        "a.ts",
        "// Runs the quickstart program.\n// https://workhorse.run/docs/gone\n",
        pages,
      ),
    ).toEqual(["a.ts header links to missing page /docs/gone"]);
  });
});
