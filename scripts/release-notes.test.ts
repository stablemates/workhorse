import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MINIMUM_SCHEMA_VERSION,
  WORKHORSE_SCHEMA_VERSION,
} from "../typescript/core/src/queue/sql-catalogue.generated.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryBlob = "https://github.com/stablemates/workhorse/blob/main/";
const coldExportGuide = "docs/guides/335-cold-export.md#a-day-is-a-utc-day";

const changelogs = [
  "CHANGELOG.md",
  "go/CHANGELOG.md",
  "python/CHANGELOG.md",
  "rust/CHANGELOG.md",
  "ruby/CHANGELOG.md",
];

/** A phrase that may wrap across lines, matched case-insensitively. */
function phrase(text: string): RegExp {
  return new RegExp(text.replace(/\*/g, "\\*").replace(/ /g, "\\s+"), "i");
}

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** The 0.6.0 release: the first entry whose notes cover migrations 0045 through 0053. */
const release = "## 0.6.0 — 2026-10-02";

/** One release entry, from its heading to the next `##` heading. */
function entry(path: string, heading: string): string {
  const text = read(path);
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, `${path} has no "${heading}" heading`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** GitHub's heading anchor: lowercase, punctuation dropped, each space a hyphen. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

function anchors(path: string): Set<string> {
  const headings = read(path)
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => slug(line.replace(/^#{1,6} /, "")));
  return new Set(headings);
}

/** Markdown link targets, resolved to repository paths where they name this repository. */
function links(
  path: string,
  section: string,
): { target: string; file?: string; anchor?: string }[] {
  return [...section.matchAll(/\]\(([^)\s]+)\)/g)].map(([, target = ""]) => {
    if (target.startsWith("http") && !target.startsWith(repositoryBlob)) return { target };
    const [location = "", anchor] = target.replace(repositoryBlob, "/").split("#");
    const file =
      location === ""
        ? path
        : location.startsWith("/")
          ? location.slice(1)
          : relative(root, resolve(root, dirname(path), location));
    return { target, file, anchor };
  });
}

describe("release notes", () => {
  it("leave the 0.5.0 notes on the schema version that release shipped", () => {
    expect(entry("CHANGELOG.md", "## 0.5.0 — 2026-09-28")).toMatch(/^Requires \*\*schema v43\*\*/m);
  });

  it("name every migration the release adds in the root notes", () => {
    // 0.5.0 shipped schema version 43, so every migration after 0044 is new in 0.6.0.
    const shipped = Number(
      /Requires \*\*schema v(\d+)\*\*/.exec(entry("CHANGELOG.md", "## 0.5.0 — 2026-09-28"))?.[1],
    );
    const section = entry("CHANGELOG.md", release);
    const added = readdirSync(join(root, "sql/migrations"))
      .map((name) => /^(\d{4})-/.exec(name)?.[1])
      .filter((number): number is string => number !== undefined && Number(number) > shipped + 1);
    expect(added.length).toBeGreaterThan(0);
    for (const number of added) expect(section, `migration ${number}`).toContain(number);
  });

  describe.each(changelogs)("%s", (path) => {
    const section = entry(path, release);

    it("states the final schema version and the compatibility floor separately", () => {
      expect(section).toMatch(phrase(`final schema version is **${WORKHORSE_SCHEMA_VERSION}**`));
      expect(section).toMatch(
        phrase(`compatibility floor (?:stays at|is) schema version **${MINIMUM_SCHEMA_VERSION}**`),
      );
    });

    it("warns that cold exporters stop across migration 0052", () => {
      expect(section).toMatch(phrase("migration 0052"));
      expect(section).toMatch(phrase("stop every cold exporter"));
      expect(section).toMatch(phrase("object and manifest uploads"));
      expect(section).toMatch(phrase("keep cold export enabled"));
      expect(section).toMatch(phrase("restart the exporters after the migration commits"));
      expect(links(path, section).map(({ file, anchor }) => `${file}#${anchor}`)).toContain(
        coldExportGuide,
      );
    });

    it("links only to files and headings that exist", () => {
      const broken = links(path, section)
        .filter(({ file, anchor }) => {
          if (file === undefined) return false;
          if (!existsSync(join(root, file))) return true;
          return anchor !== undefined && file.endsWith(".md") && !anchors(file).has(anchor);
        })
        .map(({ target }) => target);
      expect(broken).toEqual([]);
    });
  });
});
