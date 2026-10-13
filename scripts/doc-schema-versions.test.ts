import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MINIMUM_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  WORKHORSE_SCHEMA_VERSION,
} from "../typescript/core/src/queue/sql-catalogue.generated.js";
import { SCHEMA_MIGRATIONS } from "../typescript/core/src/schema.js";
import { repositoryRoot } from "./packages.js";

// The documentation states the current schema version in a few sentences. A migration changes the
// code, but nothing changed those sentences: `docs/features.md` said schema 43 while the code was at
// 68. This check holds each such sentence to the code.
//
// The source of truth is `WORKHORSE_SCHEMA_VERSION` in the generated SQL catalogue. Every SDK
// catalogue is generated from the same `protocol/v1/manifest.json`, and `pnpm sql-catalogues:check`
// keeps them equal. `SCHEMA_MIGRATIONS` gives the file of each version, so the check also ties the
// version to the highest file in `sql/migrations/`.
//
// The check reads only the sentences below. It does not read a historical number, such as the
// version that added a feature or the version a 0.7 database starts at.

/** The upgrade section of the newest release. The release that adds the next section moves this. */
const upgradeHeading = "## Upgrade from 0.7.x to 0.8.0";

function read(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

/** The numbers that `pattern` captures in `source`, or a failure that names the file and the text. */
function stated(file: string, source: string, pattern: RegExp, description: string): number[] {
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`${file}: found no sentence that states ${description} (${String(pattern)})`);
  }
  return match.slice(1).map(Number);
}

/** The text from `heading` to the next heading of the same level, or to the end of the file. */
function section(file: string, source: string, heading: string): string {
  const start = source.split("\n").findIndex((line) => line === heading);
  if (start === -1) throw new Error(`${file}: found no heading "${heading}"`);
  const lines = source.split("\n").slice(start + 1);
  const end = lines.findIndex((line) => line.startsWith("## "));
  return lines.slice(0, end === -1 ? undefined : end).join("\n");
}

const migrationFiles = readdirSync(path.join(repositoryRoot, "sql/migrations"))
  .filter((name) => /^\d{4}-.+\.sql$/.test(name))
  .toSorted();
const highestFile = migrationFiles.at(-1)!;
const highestNumber = highestFile.slice(0, 4);
const lastStep = SCHEMA_MIGRATIONS.at(-1)!;

describe("schema numbers in the documentation", () => {
  it("takes the current schema version from code that agrees with sql/migrations/", () => {
    expect(lastStep.file, "the last SCHEMA_MIGRATIONS step names the highest migration file").toBe(
      highestFile,
    );
    expect(
      lastStep.toVersion,
      "the last SCHEMA_MIGRATIONS step reaches WORKHORSE_SCHEMA_VERSION",
    ).toBe(WORKHORSE_SCHEMA_VERSION);
  });

  it("states the current schema version and protocol in docs/features.md", () => {
    const file = "docs/features.md";
    const source = read(file);
    const sentences: [RegExp, string][] = [
      [
        /snapshot for schema version (\d+) and SQL protocol (\d+)\./,
        "the schema version and protocol of the snapshot",
      ],
      [
        /Schema version (\d+) and SQL protocol (\d+) are the current contract\./,
        "the current contract in the Versioned SQL API row",
      ],
    ];
    for (const [pattern, description] of sentences) {
      const [schema, protocol] = stated(file, source, pattern, description);
      expect(
        schema,
        `${file}: ${description} must be schema version ${WORKHORSE_SCHEMA_VERSION}`,
      ).toBe(WORKHORSE_SCHEMA_VERSION);
      expect(protocol, `${file}: ${description} must be SQL protocol ${PROTOCOL_VERSION}`).toBe(
        PROTOCOL_VERSION,
      );
    }
  });

  it("states the target schema, the last migration, and the floor in the upgrade section", () => {
    const file = "docs/compatibility.md";
    const text = section(file, read(file), upgradeHeading);
    const where = `${file}, "${upgradeHeading.slice(3)}"`;

    const [, through, target] = stated(
      where,
      text,
      /applies migrations (\d{4}) through (\d{4}) and leaves the schema at\s+version (\d+)\./,
      "the migrations that `workhorse schema migrate` applies",
    );
    expect(
      String(through).padStart(4, "0"),
      `${where}: the last migration must be ${highestNumber}`,
    ).toBe(highestNumber);
    expect(target, `${where}: the target schema version must be ${WORKHORSE_SCHEMA_VERSION}`).toBe(
      WORKHORSE_SCHEMA_VERSION,
    );

    const rows = [...text.matchAll(/^\| `(\d{4}-[^`]+\.sql)`\s*\|\s*(\d+)\s*\|/gm)];
    const lastRow = rows.at(-1);
    expect(lastRow, `${where}: found no migration table`).toBeDefined();
    expect(lastRow![1], `${where}: the last table row must name ${highestFile}`).toBe(highestFile);
    expect(
      Number(lastRow![2]),
      `${where}: the last table row must give schema version ${WORKHORSE_SCHEMA_VERSION}`,
    ).toBe(WORKHORSE_SCHEMA_VERSION);

    const [floor] = stated(
      where,
      text,
      /schema floor rises from \d+ to (\d+)\./,
      "the new schema floor",
    );
    expect(floor, `${where}: the new schema floor must be ${MINIMUM_SCHEMA_VERSION}`).toBe(
      MINIMUM_SCHEMA_VERSION,
    );
  });
});
