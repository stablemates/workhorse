import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSchemaMigrationMetadata, splitSqlStatements } from "../src/schema-migrations.js";

const migrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../sql/migrations",
);

/** The clean-install artifact of the migration baseline, which creates the first tables. */
const baseline = path.resolve(migrations, "../releases/0006.sql");

/**
 * Shipped steps that scan a table under the ACCESS EXCLUSIVE lock their own ALTER took. A shipped
 * step is immutable, so each stays here with the reason its cost was accepted.
 */
const EXCLUSIVE_SCANS_SHIPPED = new Map([
  ["0025-add-a-fast-task-tier.sql", "queue_control holds one row per queue"],
  [
    "0030-release-dependents-through-a-pending-prerequisite-counter.sql",
    "backfills and validates task_runtime in one step; fresh installs and schemas past 30 skip it",
  ],
  [
    "0052-keep-cold-export-segments-one-utc-day.sql",
    "the cold-export ledger holds one row per dataset and UTC day",
  ],
  [
    "0065-give-the-terminal-cleanup-backlog-reason-its-own-health-budget.sql",
    "queue_health_policy holds one singleton row",
  ],
  [
    "0067-count-task-group-outcomes-in-counter-shards.sql",
    "task_group holds one row per task group, and ADR 0096 moves the group counts into shards in the transaction that adds the shard columns",
  ],
]);

/**
 * Shipped steps that build an index on a table an earlier step created, without CONCURRENTLY. The
 * build holds SHARE on the table, so every write to it waits for the build. A shipped step is
 * immutable, so each stays here with the reason its cost was accepted.
 */
const BLOCKING_INDEX_BUILDS_SHIPPED = new Map([
  [
    "0061-bound-the-scan-cost-of-fast-dead-letters-statistics-and-repeated-ticks.sql",
    "fast_task_outcome_failed_finished_idx shipped in 0.7.0; docs/schema-lifecycle.md tells an operator how to build it concurrently before the upgrade, so this step skips the build",
  ],
]);

/** The code of a statement, and the contents of the literals that the code no longer holds. */
interface CodeView {
  code: string;
  literals: string[];
}

/**
 * Splits a statement into code and literal values. The code keeps quoted identifiers and an empty
 * `''` or `$$` in place of each literal, and a space in place of each comment, so a value cannot
 * hide a keyword or start a comment. Block comments nest as PostgreSQL nests them.
 */
function codeView(statement: string): CodeView {
  let code = "";
  const literals: string[] = [];
  let i = 0;
  while (i < statement.length) {
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(statement.slice(i));
    if (statement.startsWith("--", i)) {
      const end = statement.indexOf("\n", i);
      i = end === -1 ? statement.length : end;
      code += " ";
    } else if (statement.startsWith("/*", i)) {
      let depth = 0;
      do {
        if (statement.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (statement.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      } while (depth > 0 && i < statement.length);
      code += " ";
    } else if (dollar !== null && !/[\w$]/.test(statement[i - 1] ?? "")) {
      const close = statement.indexOf(dollar[0], i + dollar[0].length);
      const end = close === -1 ? statement.length : close;
      literals.push(statement.slice(i + dollar[0].length, end));
      i = end + dollar[0].length;
      code += "$$";
    } else if (statement[i] === "'" || statement[i] === '"') {
      const quote = statement[i]!;
      const escapes = quote === "'" && /[eE]/.test(statement[i - 1] ?? "");
      let value = "";
      let end = i + 1;
      while (end < statement.length) {
        if (escapes && statement[end] === "\\") {
          value += statement.slice(end, end + 2);
          end += 2;
        } else if (statement[end] === quote && statement[end + 1] === quote) {
          value += quote;
          end += 2;
        } else if (statement[end] === quote) break;
        else value += statement[end++];
      }
      if (quote === '"') code += statement.slice(i, end + 1);
      else {
        literals.push(value);
        code += "''";
      }
      i = end + 1;
    } else {
      code += statement[i];
      i++;
    }
  }
  return { code: code.replaceAll(/\s+/g, " ").trim(), literals };
}

/** The code of each statement of a migration body, without comments or literal values. */
function normalizedStatements(body: string): string[] {
  return splitSqlStatements(body).map((statement) => codeView(statement).code);
}

/** A table name as PostgreSQL resolves it, so `"workhorse"."t"` and `workhorse.t` match. */
function tableName(name: string): string {
  return name.replaceAll('"', "").toLowerCase();
}

const CREATE_TABLE = /^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?([\w."]+)/i;

/** The tables that a body creates with a top-level CREATE TABLE, in statement order. */
function createdTables(body: string): string[] {
  return normalizedStatements(body).flatMap((statement) => {
    const table = CREATE_TABLE.exec(statement);
    return table === null ? [] : [tableName(table[1]!)];
  });
}

/** The ALTER TABLE subcommands of an action, split at the commas outside parentheses. */
function alterSubcommands(action: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < action.length; i++) {
    if (action[i] === "(") depth++;
    else if (action[i] === ")") depth--;
    else if (action[i] === "," && depth === 0) {
      parts.push(action.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(action.slice(start).trim());
  return parts;
}

/** True when an ALTER TABLE subcommand adds a constraint that PostgreSQL builds an index for. */
function addsIndexBackedConstraint(subcommand: string): boolean {
  return (
    /^ADD\b.*\b(?:PRIMARY KEY|UNIQUE|EXCLUDE)\b/i.test(subcommand) &&
    // Only this form attaches an existing index. USING INDEX TABLESPACE places a new one.
    !/\b(?:PRIMARY KEY|UNIQUE) USING INDEX (?!TABLESPACE\b)[\w"]+/i.test(subcommand)
  );
}

/** The index build that a code view starts with, with whether it is concurrent. */
function indexBuild(code: string): { table: string; concurrent: boolean } | null {
  const index =
    /^CREATE (?:UNIQUE )?INDEX (CONCURRENTLY )?(?:IF NOT EXISTS )?(?:[\w"%]+ )?ON (?:ONLY )?([\w."%]+)/i.exec(
      code,
    );
  return index === null
    ? null
    : { table: tableName(index[2]!), concurrent: index[1] !== undefined };
}

/** The ALTER TABLE that a code view starts with, and whether it adds an index-backed constraint. */
function indexBackedAlter(code: string): string | null {
  const alter = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([\w."%]+) (.*)$/i.exec(code);
  if (alter === null || !alterSubcommands(alter[2]!).some(addsIndexBackedConstraint)) return null;
  return tableName(alter[1]!);
}

/** The REINDEX that a code view starts with, and whether it is concurrent. */
function reindex(code: string): { concurrent: boolean } | null {
  const statement = /^REINDEX (?:\(([^)]*)\) )?\w+ (CONCURRENTLY )?/i.exec(code);
  if (statement === null) return null;
  const option = /\bCONCURRENTLY\b(?: (\w+))?/i.exec(statement[1] ?? "");
  const enabled = option !== null && !/^(?:false|off|0)$/i.test(option[1] ?? "");
  return { concurrent: statement[2] !== undefined || enabled };
}

/**
 * The index builds in the SQL text of a DO block. The block runs when the step runs, and it cannot
 * build an index concurrently. Each literal in it can be dynamic SQL, so the scan reads them too.
 */
function indexBuildsInBlock(text: string, isNew: (table: string) => boolean): string[] {
  const found: string[] = [];
  for (const statement of splitSqlStatements(text)) {
    const view = codeView(statement);
    // PL/pgSQL puts words such as BEGIN or THEN before a statement, so a match can start at any word.
    for (let at = 0; at < view.code.length; at++) {
      if (at > 0 && !/\s/.test(view.code[at - 1]!)) continue;
      const rest = view.code.slice(at);
      const index = indexBuild(rest);
      if (index !== null && !isNew(index.table)) {
        found.push(`builds an index on ${index.table} in a DO block`);
      }
      const alter = indexBackedAlter(rest);
      if (alter !== null && !isNew(alter)) {
        found.push(`adds an index-backed constraint to ${alter} in a DO block`);
      }
      if (reindex(rest) !== null) found.push("reindexes in a DO block");
    }
    for (const literal of view.literals) found.push(...indexBuildsInBlock(literal, isNew));
  }
  return found;
}

/**
 * The index builds in one step that block writes to a table that existed before the step. A table
 * counts as new only when the step creates it and no earlier step or the baseline did, because
 * CREATE TABLE IF NOT EXISTS leaves an existing table and its rows in place.
 */
function blockingIndexBuilds(body: string, existing: ReadonlySet<string> = new Set()): string[] {
  const created = new Set<string>();
  const found: string[] = [];
  const isNew = (name: string) => created.has(tableName(name));
  for (const statement of splitSqlStatements(body)) {
    const { code, literals } = codeView(statement);
    const table = CREATE_TABLE.exec(code);
    if (table !== null) {
      if (!existing.has(tableName(table[1]!))) created.add(tableName(table[1]!));
      continue;
    }
    if (/^DO\b/i.test(code)) {
      for (const literal of literals) found.push(...indexBuildsInBlock(literal, isNew));
      continue;
    }
    const index = indexBuild(code);
    if (index !== null) {
      if (!index.concurrent && !isNew(index.table)) {
        found.push(`builds an index on ${index.table} without CONCURRENTLY`);
      }
      continue;
    }
    const alter = indexBackedAlter(code);
    if (alter !== null && !isNew(alter)) {
      found.push(`adds an index-backed constraint to ${alter}`);
      continue;
    }
    if (reindex(code)?.concurrent === false) found.push("reindexes without CONCURRENTLY");
  }
  return found;
}

/** The work in one transactional step that holds a table's ACCESS EXCLUSIVE for time its size sets. */
function exclusiveScans(body: string): string[] {
  const statements = normalizedStatements(body);
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
    expect(exclusiveScans("ALTER TABLE t ADD COLUMN note text DEFAULT '--CHECK';")).toEqual([]);
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

describe("index builds on existing tables", () => {
  it("flags each way a step builds an index that blocks writes to an existing table", () => {
    expect(
      blockingIndexBuilds(`CREATE INDEX IF NOT EXISTS a ON workhorse.t (x);
CREATE UNIQUE INDEX b ON ONLY "workhorse"."t" (y);
CREATE INDEX ON workhorse.t (z);
ALTER TABLE workhorse.t ADD CONSTRAINT k UNIQUE (x);
ALTER TABLE workhorse.t ADD COLUMN c integer PRIMARY KEY;
ALTER TABLE workhorse.t ADD COLUMN cost numeric(10, 2) UNIQUE;
ALTER TABLE workhorse.t
  ADD CONSTRAINT prepared UNIQUE USING INDEX a,
  ADD CONSTRAINT fresh UNIQUE (y);
ALTER TABLE workhorse.t ADD CONSTRAINT u UNIQUE (id) USING INDEX TABLESPACE pg_default;
ALTER TABLE workhorse.t ADD CONSTRAINT p PRIMARY KEY (id) USING INDEX TABLESPACE pg_default;
ALTER TABLE workhorse.t ADD COLUMN note text DEFAULT '--', ADD CONSTRAINT v UNIQUE (id);
/* a /* nested */ comment */ CREATE INDEX d ON workhorse.t (w);
ALTER TABLE workhorse.t ADD COLUMN memo text DEFAULT $$--$$, ADD CONSTRAINT w UNIQUE (id);
ALTER TABLE workhorse.t ADD COLUMN body text DEFAULT $tag$/*$tag$, ADD CONSTRAINT x UNIQUE (id);
REINDEX (CONCURRENTLY false) TABLE workhorse.t;
REINDEX INDEX workhorse.a;`),
    ).toEqual([
      "builds an index on workhorse.t without CONCURRENTLY",
      "builds an index on workhorse.t without CONCURRENTLY",
      "builds an index on workhorse.t without CONCURRENTLY",
      "adds an index-backed constraint to workhorse.t",
      "adds an index-backed constraint to workhorse.t",
      "adds an index-backed constraint to workhorse.t",
      "adds an index-backed constraint to workhorse.t",
      "adds an index-backed constraint to workhorse.t",
      "adds an index-backed constraint to workhorse.t",
      "adds an index-backed constraint to workhorse.t",
      "builds an index on workhorse.t without CONCURRENTLY",
      "adds an index-backed constraint to workhorse.t",
      "adds an index-backed constraint to workhorse.t",
      "reindexes without CONCURRENTLY",
      "reindexes without CONCURRENTLY",
    ]);
  });

  it("flags an index build in a DO block, including dynamic SQL", () => {
    expect(
      blockingIndexBuilds(`DO $$ BEGIN
  CREATE INDEX a ON workhorse.t (id);
  EXECUTE format('CREATE INDEX %I ON workhorse.%I (id)', 'b', 't');
  ALTER TABLE workhorse.t ADD COLUMN c integer, ADD CONSTRAINT k UNIQUE (c);
  REINDEX TABLE workhorse.t;
  ALTER TABLE workhorse.t
    ADD COLUMN note text DEFAULT ';',
    ADD CONSTRAINT j UNIQUE (id);
  EXECUTE 'ALTER TABLE workhorse.t ADD COLUMN d text DEFAULT ''x'', ADD CONSTRAINT m UNIQUE (d)';
END $$;`),
    ).toEqual([
      "builds an index on workhorse.t in a DO block",
      "builds an index on workhorse.%i in a DO block",
      "adds an index-backed constraint to workhorse.t in a DO block",
      "reindexes in a DO block",
      "adds an index-backed constraint to workhorse.t in a DO block",
      "adds an index-backed constraint to workhorse.t in a DO block",
    ]);
  });

  it("treats CREATE TABLE IF NOT EXISTS of an existing table as existing", () => {
    expect(
      blockingIndexBuilds(
        `CREATE TABLE IF NOT EXISTS workhorse.task (id uuid);
CREATE INDEX a ON workhorse.task (id);`,
        new Set(["workhorse.task"]),
      ),
    ).toEqual(["builds an index on workhorse.task without CONCURRENTLY"]);
  });

  it("accepts a concurrent build, a table the same step creates, and a prepared index", () => {
    expect(
      blockingIndexBuilds(`CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON workhorse.t (x);
REINDEX INDEX CONCURRENTLY workhorse.a;
REINDEX (VERBOSE) INDEX CONCURRENTLY workhorse.a;
REINDEX (CONCURRENTLY) TABLE workhorse.t;
REINDEX (CONCURRENTLY true) TABLE workhorse.t;
ALTER TABLE workhorse.t ADD CONSTRAINT k UNIQUE USING INDEX a;
ALTER TABLE workhorse.t ADD CONSTRAINT c CHECK (x > 0);
ALTER TABLE workhorse.t ADD COLUMN note text DEFAULT 'UNIQUE';
CREATE TABLE IF NOT EXISTS workhorse.n (id integer PRIMARY KEY);
CREATE INDEX IF NOT EXISTS n_idx ON workhorse.n (id);
ALTER TABLE workhorse.n ADD CONSTRAINT n_unique UNIQUE (id);
DO $$ BEGIN CREATE INDEX n_id_idx ON workhorse.n (id); END $$;
DO $$ BEGIN
  -- CREATE INDEX c ON workhorse.t (x);
  ALTER TABLE workhorse.t ADD COLUMN label text DEFAULT 'UNIQUE';
  EXECUTE 'ALTER TABLE workhorse.t ADD COLUMN tag text DEFAULT ''UNIQUE''';
END $$;
CREATE FUNCTION workhorse.f() RETURNS void LANGUAGE plpgsql AS $$
BEGIN EXECUTE 'CREATE INDEX x ON workhorse.t (y)'; END $$;`),
    ).toEqual([]);
  });

  it("keeps every step from building an index that blocks writes to an existing table", async () => {
    // docs/schema-lifecycle.md, "Shipped migrations that block writes": a plain CREATE INDEX holds
    // SHARE on its table until the step commits, so every write to the table waits for the build.
    const existing = new Set(createdTables(await readFile(baseline, "utf8")));
    const offenders: string[] = [];
    const files = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).toSorted();
    for (const file of files) {
      const body = await readFile(path.join(migrations, file), "utf8");
      const found = blockingIndexBuilds(body, existing);
      for (const table of createdTables(body)) existing.add(table);
      if (BLOCKING_INDEX_BUILDS_SHIPPED.has(file)) {
        if (found.length === 0) offenders.push(`${file}: no longer needs its exemption`);
        continue;
      }
      offenders.push(...found.map((finding) => `${file}: ${finding}`));
    }
    expect(offenders).toEqual([]);
  });
});
