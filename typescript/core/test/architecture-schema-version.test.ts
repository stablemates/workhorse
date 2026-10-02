import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  WORKHORSE_SCHEMA_BASELINE_VERSION,
  WORKHORSE_SCHEMA_VERSION,
} from "../src/queue/sql-catalogue.generated.js";

// docs/architecture/ is the precise reference, so every statement of the current schema version
// in it must name the version the code installs (SM-1015).

const root = path.resolve(import.meta.dirname, "../../..");

/** Collapse line breaks so a statement that wraps still matches. */
const readArchitecture = async (page: string) =>
  (await readFile(path.join(root, "docs/architecture", page), "utf8")).replace(/\s+/g, " ");

/** Every capture of `pattern` in the text, as numbers; the pattern must match at least once. */
function captures(text: string, pattern: RegExp): number[][] {
  const matches = [...text.matchAll(pattern)].map((match) => match.slice(1).map(Number));
  if (matches.length === 0) throw new Error(`docs/architecture/ has no match for ${pattern}`);
  return matches;
}

describe("architecture reference schema version", () => {
  it("states the current version and baseline in the introduction", async () => {
    const text = await readArchitecture("schema-and-protocol.md");
    expect(
      captures(
        text,
        /The current schema version is (\d+) \(`WORKHORSE_SCHEMA_VERSION`\) and the migration baseline is (\d+)/g,
      ),
    ).toEqual([[WORKHORSE_SCHEMA_VERSION, WORKHORSE_SCHEMA_BASELINE_VERSION]]);
  });

  it("names the last additive step and its file", async () => {
    const text = await readArchitecture("schema-and-protocol.md");
    expect(captures(text, /The additive steps 26 through (\d+) follow/g)).toEqual([
      [WORKHORSE_SCHEMA_VERSION],
    ]);
    // From 0036 on, a file's number is one above the version it produces.
    expect(captures(text, /Their files run from `0026` to `(\d{4})`/g)).toEqual([
      [WORKHORSE_SCHEMA_VERSION + 1],
    ]);
  });

  it("refuses versions outside the baseline and the current version", async () => {
    const text = await readArchitecture("schema-and-protocol.md");
    expect(
      captures(text, /An installed version below the baseline (\d+) or above the current (\d+)/g),
    ).toEqual([[WORKHORSE_SCHEMA_BASELINE_VERSION, WORKHORSE_SCHEMA_VERSION]]);
  });

  it("states the installed version and the migration range in Operational limits", async () => {
    const text = await readArchitecture("operations.md");
    expect(
      captures(text, /The canonical artifact installs version (\d+), the whole current schema/g),
    ).toEqual([[WORKHORSE_SCHEMA_VERSION]]);
    expect(captures(text, /Version (\d+) is the migration baseline/g)).toEqual([
      [WORKHORSE_SCHEMA_BASELINE_VERSION],
    ]);
    expect(captures(text, /`sql\/migrations\/`, which run from (\d+) to (\d+)\./g)).toEqual([
      [WORKHORSE_SCHEMA_BASELINE_VERSION, WORKHORSE_SCHEMA_VERSION],
    ]);
  });
});
