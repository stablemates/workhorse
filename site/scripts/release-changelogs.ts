import { readFile } from "node:fs/promises";

import {
  type Release,
  type ReleaseLine,
  type ResolvedReleaseLine,
  releaseLines,
} from "../lib/releases.js";

/**
 * Reads the published versions of the three lines out of their changelogs.
 *
 * `/docs/releases` prints the current version of each line so a reader can
 * apply the support policy without visiting npm, PyPI, and the Go module proxy.
 * A hand-maintained table would make that policy a false statement the first
 * time a release shipped without the page being edited, so the table is
 * generated from the files the release commit already updates
 * (ADR 0058). `scripts/check-release.ts` refuses a tag whose version has no
 * changelog heading, which is what makes the changelog the authority here.
 *
 * A changelog records one version per `## <version> — <date>` heading, newest
 * first. Every malformed or out-of-order heading fails the build rather than
 * reaching the page, because the page states a security policy and a blank or a
 * misordered row in it is read as fact.
 */

/** `## 0.1.0 — 2026-09-04`, and its beta forms `0.1.0-beta.2` and `0.1.0b3`. */
const releaseHeading = /^## (\S+) — (\d{4}-\d{2}-\d{2})$/;
/** Any `##` heading, so a release heading that lost its shape is caught rather than skipped. */
const anyHeading = /^## /;

/**
 * A calendar date is valid when it names a day that exists. `2026-02-30` parses
 * and rolls over to March, so the check is that it prints back unchanged.
 */
function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/**
 * The releases `source` records, newest first, in the order the file lists them.
 *
 * File order is the answer rather than a sort, because a changelog is written
 * newest-first by hand and a sort would quietly accept an entry inserted in the
 * wrong place. The order is verified instead: dates never increase going down,
 * and no version appears twice.
 */
export function parseReleases(source: string, changelog: string): Release[] {
  const releases: Release[] = [];
  const seen = new Set<string>();

  for (const line of source.split("\n")) {
    if (!anyHeading.test(line)) continue;
    const heading = releaseHeading.exec(line);
    if (!heading?.[1] || !heading?.[2]) {
      throw new Error(
        `${changelog} has the heading "${line.trim()}", which is not "## <version> — <date>". ` +
          "Every second-level heading in a changelog is a release.",
      );
    }
    const [, version, date] = heading;
    if (!isCalendarDate(date)) {
      throw new Error(`${changelog} dates ${version} "${date}", which is not a calendar date`);
    }
    if (seen.has(version)) throw new Error(`${changelog} lists ${version} more than once`);
    seen.add(version);

    const previous = releases.at(-1);
    if (previous && previous.date < date) {
      throw new Error(
        `${changelog} lists ${version} (${date}) below ${previous.version} ` +
          `(${previous.date}), so it is not newest first`,
      );
    }
    releases.push({ version, date });
  }

  if (releases.length === 0) throw new Error(`${changelog} records no release heading`);
  return releases;
}

/**
 * Every line with its versions resolved, in `releaseLines` order. `repositoryDir`
 * is the repository root the changelog paths are relative to.
 */
async function resolveLine(line: ReleaseLine, repositoryDir: URL): Promise<ResolvedReleaseLine> {
  const source = await readFile(new URL(line.changelog, repositoryDir), "utf8");
  // `parseReleases` throws on an empty changelog, so there is always a newest.
  const [current, ...earlier] = parseReleases(source, line.changelog);
  return { ...line, current: current!, earlier };
}

export async function readReleaseLines(repositoryDir: URL): Promise<ResolvedReleaseLine[]> {
  return Promise.all(releaseLines.map((line) => resolveLine(line, repositoryDir)));
}
