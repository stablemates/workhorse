import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { releaseLines } from "../lib/releases.js";
import { assertUnreleased, parseReleases, readReleaseLines } from "./release-changelogs.js";

const repositoryRoot = pathToFileURL(`${resolve(import.meta.dirname, "../..")}/`);

describe("reading the release lines out of the changelogs", () => {
  it("keeps the file's order rather than sorting, so the newest heading is the current version", () => {
    const releases = parseReleases(
      [
        "# Changelog",
        "",
        "Prose above the first release.",
        "",
        "## 0.2.0 — 2026-10-01",
        "",
        "Notes.",
        "",
        "## 0.1.0 — 2026-09-14",
        "",
        "## 0.1.0-beta.2 — 2026-09-01",
      ].join("\n"),
      "CHANGELOG.md",
    );

    expect(releases).toEqual([
      { version: "0.2.0", date: "2026-10-01" },
      { version: "0.1.0", date: "2026-09-14" },
      { version: "0.1.0-beta.2", date: "2026-09-01" },
    ]);
  });

  it("rejects a second-level heading that is not a release", () => {
    expect(() => parseReleases("## Invalid\n", "CHANGELOG.md")).toThrow(
      /not "## <version> — <date>"/,
    );
  });

  it("keeps a leading Unreleased entry out of the published versions", () => {
    expect(
      parseReleases("## Unreleased\nUpcoming notes.\n## 0.6.1 — 2026-10-02\n", "CHANGELOG.md"),
    ).toEqual([{ version: "0.6.1", date: "2026-10-02" }]);
    expect(() => parseReleases("## Unreleased\n", "CHANGELOG.md")).toThrow(
      /records no release heading/,
    );
  });

  it.each([
    "## Unreleased\n## Unreleased\n## 0.6.1 — 2026-10-02",
    "## 0.6.1 — 2026-10-02\n## Unreleased",
  ])("rejects duplicated or misplaced Unreleased headings", (source) => {
    expect(() => parseReleases(source, "CHANGELOG.md")).toThrow(/Only one leading Unreleased/);
  });

  it("rejects a date that names no day", () => {
    expect(() => parseReleases("## 0.1.0 — 2026-02-30\n", "CHANGELOG.md")).toThrow(
      /not a calendar date/,
    );
  });

  it("rejects a release inserted out of order, which a sort would have hidden", () => {
    expect(() =>
      parseReleases(["## 0.1.0 — 2026-09-01", "## 0.2.0 — 2026-10-01"].join("\n"), "CHANGELOG.md"),
    ).toThrow(/not newest first/);
  });

  it("rejects the same version twice", () => {
    expect(() =>
      parseReleases(["## 0.1.0 — 2026-09-14", "## 0.1.0 — 2026-09-01"].join("\n"), "CHANGELOG.md"),
    ).toThrow(/more than once/);
  });

  it("rejects a changelog with no release at all", () => {
    expect(() => parseReleases("# Changelog\n\nNothing yet.\n", "go/CHANGELOG.md")).toThrow(
      /records no release heading/,
    );
  });

  it("accepts only `## Unreleased` from a line that has not released", () => {
    expect(() =>
      assertUnreleased("# Ruby changelog\n\n## Unreleased\n\n- Notes.\n", "ruby/CHANGELOG.md"),
    ).not.toThrow();
    expect(() =>
      assertUnreleased("## Unreleased\n\n## 0.5.0 — 2026-10-01\n", "ruby/CHANGELOG.md"),
    ).toThrow(/marked unpublished/);
  });

  it("resolves every line from the repository's own changelogs", async () => {
    const lines = await readReleaseLines(repositoryRoot);

    expect(lines.map((line) => line.id)).toEqual(releaseLines.map((line) => line.id));
    // An unpublished line states no version, so it has nothing below to compare.
    expect(lines.filter((line) => line.unpublished).map((line) => line.current)).toEqual(
      lines.filter((line) => line.unpublished).map(() => null),
    );
    for (const line of lines.filter((candidate) => !candidate.unpublished)) {
      if (!line.current) throw new Error(`${line.changelog} has no current version`);
      expect(line.current.version, `${line.changelog} has no current version`).toMatch(/\d/);
      expect(line.current.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The current version is the newest, so nothing earlier may outrank it.
      for (const release of line.earlier) {
        expect(release.date <= line.current.date).toBe(true);
      }
    }
  });
});
