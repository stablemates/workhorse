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

/** The text between the Unreleased heading and the next release heading. */
function unreleased(path: string): string {
  const text = read(path);
  const start = text.search(/^#{2,3} Unreleased$/m);
  expect(start, `${path} has no Unreleased heading`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start).split("\n").slice(1).join("\n");
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
    const text = read("CHANGELOG.md");
    const release = text.slice(text.indexOf("## 0.5.0 — 2026-09-28"));
    expect(release).toMatch(/^Requires \*\*schema v43\*\*/m);
  });

  it("name every migration the release adds in the root notes", () => {
    const shipped = Number(/Requires \*\*schema v(\d+)\*\*/.exec(read("CHANGELOG.md"))?.[1]);
    const section = unreleased("CHANGELOG.md");
    const added = readdirSync(join(root, "sql/migrations"))
      .map((name) => /^(\d{4})-/.exec(name)?.[1])
      .filter((number): number is string => number !== undefined && Number(number) > shipped + 1);
    expect(added.length).toBeGreaterThan(0);
    for (const number of added) expect(section, `migration ${number}`).toContain(number);
  });

  describe.each(changelogs)("%s", (path) => {
    const section = unreleased(path);

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
          if (anchor === "unreleased") return true;
          if (file === undefined) return false;
          if (!existsSync(join(root, file))) return true;
          return anchor !== undefined && file.endsWith(".md") && !anchors(file).has(anchor);
        })
        .map(({ target }) => target);
      expect(broken).toEqual([]);
    });
  });
});
