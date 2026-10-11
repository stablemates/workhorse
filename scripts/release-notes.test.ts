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

/** Heading anchors and explicit `<a id>` anchors, which keep an old link valid after a rename. */
function anchors(path: string): Set<string> {
  const text = read(path);
  const headings = text
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => slug(line.replace(/^#{1,6} /, "")));
  const explicit = [...text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)].map((match) => match[1]!);
  return new Set([...headings, ...explicit]);
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
      .filter(
        (number): number is string =>
          number !== undefined && Number(number) > shipped + 1 && Number(number) <= 53,
      );
    expect(added.length).toBeGreaterThan(0);
    for (const number of added) expect(section, `migration ${number}`).toContain(number);
  });

  describe.each(changelogs)("%s", (path) => {
    const section = entry(path, release);

    it("states the final schema version and the compatibility floor separately", () => {
      expect(section).toMatch(phrase(`final schema version is **52**`));
      expect(section).toMatch(phrase(`compatibility floor (?:stays at|is) schema version **43**`));
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

/** The 0.6.1 release: no migration, rebuilt so the Python distribution carries attestations. */
const patch = "## 0.6.1 — 2026-10-02";

describe("0.6.1 release notes", () => {
  it("say why the release exists in the root notes", () => {
    const section = entry("CHANGELOG.md", patch);
    expect(section).toMatch(phrase("PEP 740 attestations"));
    expect(section).toMatch(phrase("adds no migration"));
  });

  describe.each(changelogs)("%s", (path) => {
    const section = entry(path, patch);

    it("keep the schema version 0.6.0 shipped", () => {
      expect(section).toMatch(/^Requires \*\*schema v43\*\*/m);
      expect(section).toMatch(phrase(`final schema version is **52**`));
      expect(entry(path, release)).toMatch(phrase(`final schema version is **52**`));
      expect(section).toMatch(phrase(`compatibility floor stays at schema version **43**`));
    });

    it("link only to files and headings that exist", () => {
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

/** The 0.7.0 release: the first entry whose notes cover migrations 0054 through 0065. */
const minor = "## 0.7.0 — 2026-10-09";

describe("0.7.0 release notes", () => {
  describe.each(changelogs)("%s", (path) => {
    const section = entry(path, minor);

    it("states the current schema, compatibility floor, and migration before rollout", () => {
      expect(section).toMatch(/^Requires \*\*schema v54\*\*/m);
      expect(section).toMatch(phrase(`final schema version is **${WORKHORSE_SCHEMA_VERSION}**`));
      expect(section).toMatch(
        phrase(`compatibility floor is schema version **${MINIMUM_SCHEMA_VERSION}**`),
      );
      expect(section).toMatch(phrase("Migration 0054"));
      expect(section).toMatch(phrase("Migrate the schema before starting updated processes"));
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

  it("names every migration added after 0.6.1 in the root notes", () => {
    // 0.6.0 and 0.6.1 shipped schema version 52, so every migration after 0053 is new in 0.7.0.
    const section = entry("CHANGELOG.md", minor);
    const added = readdirSync(join(root, "sql/migrations"))
      .map((name) => /^(\d{4})-/.exec(name)?.[1])
      .filter((number): number is string => number !== undefined && Number(number) > 53);
    expect(added.length).toBeGreaterThan(0);
    for (const number of added) expect(section, `migration ${number}`).toContain(number);
  });
});

/** The 0.7.1 release: no migration, re-cut because the npm publish of 0.7.0 stopped partway. */
const recut = "## 0.7.1 — 2026-10-09";

describe("0.7.1 release notes", () => {
  it("say why the release exists in the root notes", () => {
    const section = entry("CHANGELOG.md", recut);
    expect(section).toMatch(phrase("npm publish of 0.7.0 stopped partway"));
    expect(section).toMatch(phrase("deprecated in favour of 0.7.1"));
    expect(section).toMatch(phrase("adds no migration"));
  });

  describe.each(changelogs)("%s", (path) => {
    const section = entry(path, recut);

    it("keep the schema version 0.7.0 shipped", () => {
      expect(section).toMatch(/^Requires \*\*schema v54\*\*/m);
      expect(section).toMatch(phrase(`final schema version is **${WORKHORSE_SCHEMA_VERSION}**`));
      expect(entry(path, minor)).toMatch(
        phrase(`final schema version is **${WORKHORSE_SCHEMA_VERSION}**`),
      );
      expect(section).toMatch(
        phrase(`compatibility floor stays at schema version **${MINIMUM_SCHEMA_VERSION}**`),
      );
    });

    it("link only to files and headings that exist", () => {
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
