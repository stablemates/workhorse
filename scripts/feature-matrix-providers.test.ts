import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./packages.js";

// `docs/features.md` counts the ORM providers and gives each one a row. A new provider package
// changed the code, but nothing changed the matrix: it said "Four ORM providers" and had no Knex row
// while `@stablemates/workhorse-knex` shipped. This check holds the matrix to the provider packages.
//
// A provider package is a public package under `typescript/` whose description ends in
// "provider for Workhorse". The word before "provider", without "ORM", names the tool.

const numberWords = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
];

function providerTools(): string[] {
  const root = path.join(repositoryRoot, "typescript");
  const tools: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifest: { private?: boolean; description?: string };
    try {
      manifest = JSON.parse(readFileSync(path.join(root, entry.name, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (manifest.private === true) continue;
    const match = /(\w+) (?:ORM )?provider for Workhorse$/.exec(manifest.description ?? "");
    if (match) tools.push(match[1]!);
  }
  return tools.toSorted();
}

const features = readFileSync(path.join(repositoryRoot, "docs/features.md"), "utf8");
const rows = features.split("\n").filter((line) => line.startsWith("|"));

describe("feature matrix ORM providers", () => {
  const tools = providerTools();

  it("finds the provider packages", () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  it("counts every provider package in the overview", () => {
    expect(features).toContain(`| ${numberWords[tools.length]} ORM providers `);
  });

  it.each(tools)("gives the %s provider its own row", (tool) => {
    expect(rows.some((row) => new RegExp(`^\\| ${tool} (?:ORM )?provider +\\|`).test(row))).toBe(
      true,
    );
  });

  it.each(tools)("names the %s provider in the additional ORM integrations row", (tool) => {
    const row = rows.find((line) => line.startsWith("| Additional ORM integrations "));
    expect(row).toContain(tool);
  });
});
