import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSchemaMigrationMetadata, splitSqlStatements } from "../src/schema-migrations.js";

const migrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../sql/migrations",
);

/**
 * Shipped steps that scan a table under the ACCESS EXCLUSIVE lock their own ALTER took. A shipped
 * step is immutable, so each stays here with the reason its cost was accepted.
 */
const EXCLUSIVE_SCANS_SHIPPED = new Map([
  ["0025-add-a-fast-task-tier.sql", "queue_control holds one row per queue"],
  [
    "0030-release-dependents-through-a-pending-prerequisite-counter.sql",
    "blocks task_runtime for time its size sets; docs/schema-lifecycle.md records the cost",
  ],
]);

/** The work in one transactional step that holds a table's ACCESS EXCLUSIVE for time its size sets. */
function exclusiveScans(body: string): string[] {
  const statements = splitSqlStatements(body).map((statement) =>
    statement
      .replaceAll(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ")
      .replaceAll(/\s+/g, " ")
      .trim(),
  );
  const altered = new Set<string>();
  const found: string[] = [];
  for (const statement of statements) {
    const alter = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([\w."]+) (.*)$/i.exec(statement);
    if (alter !== null) {
      const [, table, action] = alter as unknown as [string, string, string];
      if (/^VALIDATE CONSTRAINT\b/i.test(action)) {
        if (altered.has(table)) found.push(`validates a constraint on ${table} it altered`);
        continue;
      }
      if (/\bADD COLUMN\b[^,]*\bCHECK\b/i.test(action)) {
        found.push(`adds a column to ${table} with an inline CHECK`);
      }
      altered.add(table);
      continue;
    }
    const write = /^(?:UPDATE|DELETE FROM) (?:ONLY )?([\w."]+)/i.exec(statement);
    if (write !== null && altered.has(write[1]!)) {
      found.push(`rewrites ${write[1]!} after altering it`);
    }
  }
  return found;
}

describe("splitSqlStatements", () => {
  it("splits a body at the semicolons that end statements", () => {
    expect(
      splitSqlStatements(
        "CREATE INDEX CONCURRENTLY a ON t (x);\nCREATE INDEX CONCURRENTLY b ON t (y);\n",
      ),
    ).toEqual(["CREATE INDEX CONCURRENTLY a ON t (x)", "CREATE INDEX CONCURRENTLY b ON t (y)"]);
  });

  it("returns a trailing statement that carries no semicolon", () => {
    expect(splitSqlStatements("SELECT 1")).toEqual(["SELECT 1"]);
  });

  it("ignores empty statements and whitespace between them", () => {
    expect(splitSqlStatements(" ;\nSELECT 1;\n\n;")).toEqual(["SELECT 1"]);
  });

  it("keeps a semicolon inside a string, an identifier, or a comment", () => {
    expect(splitSqlStatements("SELECT 'a;b', \"c;d\";")).toEqual(["SELECT 'a;b', \"c;d\""]);
    expect(splitSqlStatements("SELECT 'it''s; fine';")).toEqual(["SELECT 'it''s; fine'"]);
    expect(splitSqlStatements("-- a; comment\nSELECT 1;")).toEqual(["-- a; comment\nSELECT 1"]);
    expect(splitSqlStatements("/* a; /* nested; */ still */ SELECT 1;")).toEqual([
      "/* a; /* nested; */ still */ SELECT 1",
    ]);
  });

  it("keeps an E-string's escaped quote from ending the string", () => {
    expect(splitSqlStatements("SELECT E'\\';a', 2;")).toEqual(["SELECT E'\\';a', 2"]);
  });

  it("keeps a dollar-quoted body whole", () => {
    const body =
      "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  PERFORM 1;\nEND\n$$;\nSELECT 1;";
    expect(splitSqlStatements(body)).toEqual([
      "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  PERFORM 1;\nEND\n$$",
      "SELECT 1",
    ]);
  });

  it("keeps a tagged dollar-quoted body whole and does not confuse it with a parameter", () => {
    expect(splitSqlStatements("SELECT $tag$a;b$tag$, $1;")).toEqual(["SELECT $tag$a;b$tag$, $1"]);
  });
});

describe("parseSchemaMigrationMetadata", () => {
  it("reports no execution when the declaration omits it", () => {
    expect(
      parseSchemaMigrationMetadata("0002.sql", '-- workhorse-migration: {"kind":"additive"}'),
    ).toEqual({ kind: "additive", execution: undefined, retiresProtocolVersions: undefined });
  });

  it("reads a non-transactional declaration", () => {
    expect(
      parseSchemaMigrationMetadata(
        "0002.sql",
        '-- workhorse-migration: {"kind":"additive","execution":"nontransactional"}\nSELECT 1;',
      ).execution,
    ).toBe("nontransactional");
  });

  it("rejects an execution it does not recognize", () => {
    expect(() =>
      parseSchemaMigrationMetadata(
        "0002.sql",
        '-- workhorse-migration: {"kind":"additive","execution":"concurrent"}',
      ),
    ).toThrow('must declare "execution" as "transactional" or "nontransactional"');
  });
});

describe("hot-table migration steps", () => {
  it("flags each way a step holds ACCESS EXCLUSIVE for a table-sized scan", () => {
    expect(
      exclusiveScans(`ALTER TABLE t ADD COLUMN c integer NOT NULL DEFAULT 0 CHECK (c >= 0);
ALTER TABLE t ADD CONSTRAINT k CHECK (c >= 0) NOT VALID;
UPDATE t SET c = 1;
ALTER TABLE t VALIDATE CONSTRAINT k;`),
    ).toEqual([
      "adds a column to t with an inline CHECK",
      "rewrites t after altering it",
      "validates a constraint on t it altered",
    ]);
  });

  it("accepts each half of the split pattern as its own step", () => {
    expect(
      exclusiveScans(`ALTER TABLE t ADD COLUMN c integer NOT NULL DEFAULT 0;
ALTER TABLE t ADD CONSTRAINT k CHECK (c >= 0) NOT VALID;`),
    ).toEqual([]);
    expect(
      exclusiveScans("UPDATE t SET c = 1;\nCREATE FUNCTION f() RETURNS void AS $$ $$;"),
    ).toEqual([]);
    expect(exclusiveScans("ALTER TABLE t VALIDATE CONSTRAINT k;")).toEqual([]);
  });

  it("keeps every transactional step from scanning a table it locked exclusively", async () => {
    // docs/schema-lifecycle.md, "Backfills and constraints on large tables": the ALTER takes ACCESS
    // EXCLUSIVE, and a scan in the same transaction keeps it for as long as the table takes to read.
    const offenders: string[] = [];
    for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql"))) {
      const body = await readFile(path.join(migrations, file), "utf8");
      if (parseSchemaMigrationMetadata(file, body).execution === "nontransactional") continue;
      const found = exclusiveScans(body);
      if (EXCLUSIVE_SCANS_SHIPPED.has(file)) {
        if (found.length === 0) offenders.push(`${file}: no longer needs its exemption`);
        continue;
      }
      offenders.push(...found.map((finding) => `${file}: ${finding}`));
    }
    expect(offenders).toEqual([]);
  });
});
