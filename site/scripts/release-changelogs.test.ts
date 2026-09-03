import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { releaseLines } from "../lib/releases.js";
import { parseReleases, readReleaseLines } from "./release-changelogs.js";

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
    expect(() => parseReleases("## Unreleased\n", "CHANGELOG.md")).toThrow(
      /not "## <version> — <date>"/,
    );
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

  it("resolves all three lines from the repository's own changelogs", async () => {
    const lines = await readReleaseLines(repositoryRoot);

    expect(lines.map((line) => line.id)).toEqual(releaseLines.map((line) => line.id));
    for (const line of lines) {
      expect(line.current.version, `${line.changelog} has no current version`).toMatch(/\d/);
      expect(line.current.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The current version is the newest, so nothing earlier may outrank it.
      for (const release of line.earlier) {
        expect(release.date <= line.current.date).toBe(true);
      }
    }
  });
});
