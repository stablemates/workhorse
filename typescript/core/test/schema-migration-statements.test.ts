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

/** A table name as PostgreSQL resolves it, so `"workhorse"."t"` and `workhorse.t` match. */
function tableName(name: string): string {
  return name.replaceAll('"', "").toLowerCase();
}

const CREATE_TABLE = /^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?([\w."]+)/i;

/** The tables that a body creates with CREATE TABLE, at the top level or in a DO block, in order. */
function createdTables(body: string): string[] {
  return splitSqlStatements(body).flatMap((statement) => {
    const { code, literals } = codeView(statement);
    if (/^DO\b/i.test(code)) {
      return literals
        .flatMap(blockStatements)
        .flatMap((item) => (item.kind === "create" ? [item.table] : []));
    }
    const table = CREATE_TABLE.exec(code);
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

/** A column name in the code view of an ALTER TABLE subcommand. */
const COLUMN = String.raw`(?:\w+|"[^"]*")`;

/** An expression that PostgreSQL evaluates one time and stores without a table rewrite. */
const STORED_DEFAULT =
  /^(?:(?:\w+ |E|U&|B|X)?''|\$\$|[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?|TRUE|FALSE|NULL|CURRENT_DATE|CURRENT_TIMESTAMP|LOCALTIMESTAMP|now\(\)|transaction_timestamp\(\))(?: ?:: ?[\w."]+(?: \w+)*(?:\(\d+(?:, ?\d+)?\))?(?:\[\])*)*$/i;

/**
 * The default expression of an ADD COLUMN subcommand, or null when it has none. The expression
 * ends at the next column constraint.
 */
function addedColumnDefault(subcommand: string): string | null {
  if (
    !/^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(?!(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b)/i.test(
      subcommand,
    )
  ) {
    return null;
  }
  const value =
    /\bDEFAULT (.+?)(?: (?:NOT NULL|NULL|CHECK|REFERENCES|UNIQUE|PRIMARY KEY|CONSTRAINT|COLLATE|GENERATED)\b.*)?$/i.exec(
      subcommand,
    );
  if (value === null) return null;
  let expression = value[1]!.trim();
  while (/^\(.*\)$/.test(expression)) expression = expression.slice(1, -1).trim();
  return expression;
}

/**
 * The CHECK (column IS NOT NULL) constraints of the earlier steps, keyed by table and constraint
 * name, with the column of each. A validated one lets SET NOT NULL skip its scan.
 */
interface NotNullChecks {
  readonly pending: Map<string, string>;
  readonly validated: Map<string, string>;
}

const noNotNullChecks = (): NotNullChecks => ({ pending: new Map(), validated: new Map() });

/** An ALTER TABLE statement, with its table, its subcommands, and whether a DO block runs it. */
interface AlterStatement {
  kind: "alter";
  table: string;
  subcommands: string[];
  inBlock: boolean;
}

/** A statement in a DO block that the scan for table-sized work reads. */
type BlockStatement = AlterStatement | { kind: "create"; table: string };

/** The ALTER TABLE that a code view starts with. */
function alterTable(code: string, inBlock: boolean): AlterStatement | null {
  const alter = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([\w."%]+) (.*)$/i.exec(code);
  return alter === null
    ? null
    : { kind: "alter", table: alter[1]!, subcommands: alterSubcommands(alter[2]!), inBlock };
}

/**
 * The CREATE TABLE and ALTER TABLE statements in the SQL text of a DO block, including dynamic SQL
 * in its literals. PL/pgSQL puts words such as BEGIN or THEN before a statement, so a match can
 * start at any word.
 */
function blockStatements(text: string): BlockStatement[] {
  const found: BlockStatement[] = [];
  for (const statement of splitSqlStatements(text)) {
    const view = codeView(statement);
    for (let at = 0; at < view.code.length; at++) {
      if (at > 0 && !/\s/.test(view.code[at - 1]!)) continue;
      const rest = view.code.slice(at);
      const created = CREATE_TABLE.exec(rest);
      if (created !== null) found.push({ kind: "create", table: tableName(created[1]!) });
      const alter = alterTable(rest, true);
      if (alter !== null) found.push(alter);
    }
    for (const literal of view.literals) found.push(...blockStatements(literal));
  }
  return found;
}

/** The ALTER TABLE statements of a step in order, with those of each DO block in its place. */
function alterStatements(body: string): AlterStatement[] {
  return splitSqlStatements(body).flatMap((statement) => {
    const { code, literals } = codeView(statement);
    if (/^DO\b/i.test(code)) {
      return literals
        .flatMap(blockStatements)
        .filter((item): item is AlterStatement => item.kind === "alter");
    }
    const alter = alterTable(code, false);
    return alter === null ? [] : [alter];
  });
}

const NAME_END = String.raw`(?= |$)`;

/**
 * A column or constraint name as PostgreSQL resolves it: a quoted name keeps its case, and an
 * unquoted name folds to lower case.
 */
function identifier(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase();
}

/**
 * Removes each NOT NULL check that a subcommand removes or moves. DROP CONSTRAINT drops the check,
 * and DROP COLUMN drops each check on the column. A rename of the column, the constraint, or the
 * table also discards the check, because the scan does not follow names.
 */
function removeNotNullChecks(table: string, subcommand: string, checks: Map<string, string>): void {
  const prefix = `${tableName(table)} `;
  const onTable = (keep: (key: string, column: string) => boolean) => {
    for (const [key, column] of checks) {
      if (key.startsWith(prefix) && !keep(key, column)) checks.delete(key);
    }
  };
  const constraint = new RegExp(
    String.raw`^(?:DROP CONSTRAINT (?:IF EXISTS )?|RENAME CONSTRAINT )(${COLUMN})${NAME_END}`,
    "i",
  ).exec(subcommand);
  if (constraint !== null) {
    checks.delete(`${prefix}${identifier(constraint[1]!)}`);
    return;
  }
  if (/^RENAME TO\b/i.test(subcommand)) {
    onTable(() => false);
    return;
  }
  const column = new RegExp(
    String.raw`^(?:DROP (?:COLUMN )?(?:IF EXISTS )?|RENAME (?:COLUMN )?)(${COLUMN})${NAME_END}`,
    "i",
  ).exec(subcommand);
  if (column !== null) onTable((_, checked) => checked !== identifier(column[1]!));
}

/**
 * Adds the NOT NULL checks that one step adds, validates, or removes, after the scan of the step.
 * A DO block can run a statement in a branch that does not execute, so a check that a DO block
 * adds or validates is no proof. A removal in a DO block still counts.
 */
function recordNotNullChecks(body: string, checks: NotNullChecks): void {
  for (const { table, subcommands, inBlock } of alterStatements(body)) {
    for (const subcommand of subcommands) {
      removeNotNullChecks(table, subcommand, checks.pending);
      removeNotNullChecks(table, subcommand, checks.validated);
      if (inBlock) continue;
      const added = new RegExp(
        String.raw`^ADD CONSTRAINT (${COLUMN}) CHECK \(\(?(${COLUMN}) IS NOT NULL\)?\)( NOT VALID)?$`,
        "i",
      ).exec(subcommand);
      if (added !== null) {
        const key = `${tableName(table)} ${identifier(added[1]!)}`;
        (added[3] === undefined ? checks.validated : checks.pending).set(
          key,
          identifier(added[2]!),
        );
        continue;
      }
      const validated = new RegExp(
        String.raw`^VALIDATE CONSTRAINT (${COLUMN})${NAME_END}`,
        "i",
      ).exec(subcommand);
      if (validated === null) continue;
      const key = `${tableName(table)} ${identifier(validated[1]!)}`;
      const column = checks.pending.get(key);
      checks.pending.delete(key);
      if (column !== undefined) checks.validated.set(key, column);
    }
  }
}

/**
 * The subcommand work that scans or rewrites the whole table under ACCESS EXCLUSIVE. `proofs` holds
 * the validated NOT NULL checks that still exist when the subcommand runs.
 */
function tableSizedSubcommand(
  subcommand: string,
  table: string,
  proofs: ReadonlyMap<string, string>,
): string | null {
  const notNull = new RegExp(String.raw`^ALTER (?:COLUMN )?(${COLUMN}) SET NOT NULL\b`, "i").exec(
    subcommand,
  );
  if (notNull !== null) {
    const proven = [...proofs].some(
      ([key, column]) =>
        key.startsWith(`${tableName(table)} `) && column === identifier(notNull[1]!),
    );
    return proven ? null : `sets NOT NULL on a column of ${table}`;
  }
  if (
    new RegExp(String.raw`^ALTER (?:COLUMN )?${COLUMN} (?:SET DATA )?TYPE\b`, "i").test(subcommand)
  ) {
    return `changes the type of a column of ${table}`;
  }
  const value = addedColumnDefault(subcommand);
  if (value !== null && !STORED_DEFAULT.test(value)) {
    return `adds a column to ${table} with a default that is not a constant`;
  }
  return null;
}

/** What the earlier steps and the baseline left: their tables and their NOT NULL checks. */
interface EarlierSteps {
  readonly existing?: ReadonlySet<string>;
  readonly checks?: NotNullChecks;
}

/**
 * The work in one transactional step that holds a table's ACCESS EXCLUSIVE for time its size sets.
 * A table counts as new only when the step creates it and no earlier step or the baseline did, as
 * in blockingIndexBuilds. SET NOT NULL, a type change, and a default that is not a constant are
 * accepted on a new table, because it holds no rows yet. SET NOT NULL is also accepted when an
 * earlier step validated a CHECK (column IS NOT NULL) on the column and the step has not removed
 * it, because PostgreSQL then skips the scan. The scan reads the DO blocks of the step for these
 * three statements.
 */
function exclusiveScans(
  body: string,
  { existing = new Set(), checks = noNotNullChecks() }: EarlierSteps = {},
): string[] {
  const altered = new Set<string>();
  const created = new Set<string>();
  const proofs = new Map(checks.validated);
  const found: string[] = [];
  const tableSized = ({ table, subcommands, inBlock }: AlterStatement) => {
    for (const subcommand of subcommands) removeNotNullChecks(table, subcommand, proofs);
    if (created.has(tableName(table))) return;
    for (const subcommand of subcommands) {
      const finding = tableSizedSubcommand(subcommand, table, proofs);
      if (finding !== null) found.push(inBlock ? `${finding} in a DO block` : finding);
    }
  };
  for (const statement of splitSqlStatements(body)) {
    const { code, literals } = codeView(statement);
    const createdTable = CREATE_TABLE.exec(code);
    if (createdTable !== null && !existing.has(tableName(createdTable[1]!))) {
      created.add(tableName(createdTable[1]!));
    }
    if (/^DO\b/i.test(code)) {
      for (const item of literals.flatMap(blockStatements)) {
        if (item.kind === "alter") tableSized(item);
        else if (!existing.has(item.table)) created.add(item.table);
      }
      continue;
    }
    const alter = alterTable(code, false);
    if (alter !== null) {
      const { table, subcommands } = alter;
      const validates = subcommands.filter((subcommand) =>
        /^VALIDATE CONSTRAINT\b/i.test(subcommand),
      );
      if (validates.length > 0 && altered.has(table)) {
        found.push(`validates a constraint on ${table} it altered`);
      }
      if (subcommands.some((subcommand) => /^ADD COLUMN\b[^,]*\bCHECK\b/i.test(subcommand))) {
        found.push(`adds a column to ${table} with an inline CHECK`);
      }
      tableSized(alter);
      if (validates.length < subcommands.length) altered.add(table);
      continue;
    }
    const write = /^(?:UPDATE|DELETE FROM) (?:ONLY )?([\w."]+)/i.exec(code);
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
ALTER TABLE t VALIDATE CONSTRAINT k;
ALTER TABLE workhorse.task_runtime ALTER COLUMN queue_name SET NOT NULL;
ALTER TABLE t ALTER c TYPE bigint, ALTER COLUMN "d" SET DATA TYPE text;
ALTER TABLE t ADD COLUMN started_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE t ADD token uuid DEFAULT gen_random_uuid() NOT NULL;
ALTER TABLE u VALIDATE CONSTRAINT k, ALTER COLUMN c TYPE bigint;
DO $$ BEGIN
  ALTER TABLE workhorse.t ADD COLUMN token uuid DEFAULT gen_random_uuid();
  EXECUTE 'ALTER TABLE workhorse.t ALTER COLUMN c SET NOT NULL';
END $$;`),
    ).toEqual([
      "adds a column to t with an inline CHECK",
      "rewrites t after altering it",
      "validates a constraint on t it altered",
      "sets NOT NULL on a column of workhorse.task_runtime",
      "changes the type of a column of t",
      "changes the type of a column of t",
      "adds a column to t with a default that is not a constant",
      "adds a column to t with a default that is not a constant",
      "changes the type of a column of u",
      "adds a column to workhorse.t with a default that is not a constant in a DO block",
      "sets NOT NULL on a column of workhorse.t in a DO block",
    ]);
  });

  it("treats CREATE TABLE IF NOT EXISTS of an existing table as existing", () => {
    expect(
      exclusiveScans(
        `CREATE TABLE IF NOT EXISTS workhorse.task (id uuid);
ALTER TABLE workhorse.task ALTER COLUMN id SET NOT NULL;`,
        { existing: new Set(["workhorse.task"]) },
      ),
    ).toEqual(["sets NOT NULL on a column of workhorse.task"]);
  });

  it("accepts SET NOT NULL after an earlier step validated a NOT NULL check on the column", () => {
    const checks = noNotNullChecks();
    recordNotNullChecks(
      `ALTER TABLE workhorse.t ADD CONSTRAINT t_c_not_null CHECK (c IS NOT NULL) NOT VALID;
ALTER TABLE workhorse.t ADD CONSTRAINT t_d_not_null CHECK (d IS NOT NULL) NOT VALID;`,
      checks,
    );
    const finalStep = `ALTER TABLE workhorse.t ALTER COLUMN c SET NOT NULL;
ALTER TABLE workhorse.t DROP CONSTRAINT t_c_not_null;`;
    expect(exclusiveScans(finalStep, { checks })).toEqual([
      "sets NOT NULL on a column of workhorse.t",
    ]);
    recordNotNullChecks("ALTER TABLE workhorse.t VALIDATE CONSTRAINT t_c_not_null;", checks);
    expect(exclusiveScans(finalStep, { checks })).toEqual([]);
    expect(
      exclusiveScans("ALTER TABLE workhorse.t ALTER COLUMN d SET NOT NULL;", { checks }),
    ).toEqual(["sets NOT NULL on a column of workhorse.t"]);
    expect(
      exclusiveScans("ALTER TABLE workhorse.u ALTER COLUMN c SET NOT NULL;", { checks }),
    ).toEqual(["sets NOT NULL on a column of workhorse.u"]);
    // A drop earlier in the step, or in the same statement, removes the proof before SET NOT NULL.
    expect(
      exclusiveScans(
        `ALTER TABLE workhorse.t DROP CONSTRAINT t_c_not_null;
ALTER TABLE workhorse.t ALTER COLUMN c SET NOT NULL;`,
        { checks },
      ),
    ).toEqual(["sets NOT NULL on a column of workhorse.t"]);
    expect(
      exclusiveScans(
        "ALTER TABLE workhorse.t ALTER COLUMN c SET NOT NULL, DROP CONSTRAINT t_c_not_null;",
        { checks },
      ),
    ).toEqual(["sets NOT NULL on a column of workhorse.t"]);
    recordNotNullChecks(finalStep, checks);
    expect(
      exclusiveScans("ALTER TABLE workhorse.t ALTER COLUMN c SET NOT NULL;", { checks }),
    ).toEqual(["sets NOT NULL on a column of workhorse.t"]);
  });

  it("takes no NOT NULL proof from a DO block, and forgets one when its column is dropped", () => {
    const setNotNull = "ALTER TABLE workhorse.t ALTER COLUMN c SET NOT NULL;";
    const fromBlock = noNotNullChecks();
    recordNotNullChecks(
      `DO $$ BEGIN
  IF false THEN
    ALTER TABLE workhorse.t ADD CONSTRAINT nn CHECK (c IS NOT NULL);
  END IF;
END $$;`,
      fromBlock,
    );
    expect(exclusiveScans(setNotNull, { checks: fromBlock })).toEqual([
      "sets NOT NULL on a column of workhorse.t",
    ]);

    const checks = noNotNullChecks();
    recordNotNullChecks("ALTER TABLE workhorse.t ADD CONSTRAINT nn CHECK (c IS NOT NULL);", checks);
    expect(exclusiveScans(setNotNull, { checks })).toEqual([]);
    expect(
      exclusiveScans(
        `ALTER TABLE workhorse.t DROP COLUMN c;
ALTER TABLE workhorse.t ADD COLUMN c integer DEFAULT 0;
${setNotNull}`,
        { checks },
      ),
    ).toEqual(["sets NOT NULL on a column of workhorse.t"]);
    recordNotNullChecks("ALTER TABLE workhorse.t DROP COLUMN IF EXISTS c;", checks);
    expect(exclusiveScans(setNotNull, { checks })).toEqual([
      "sets NOT NULL on a column of workhorse.t",
    ]);
  });

  it("forgets a NOT NULL check after a rename, and keeps the case of a quoted column", () => {
    const setNotNull = "ALTER TABLE workhorse.t ALTER COLUMN c SET NOT NULL;";
    const validCheck = "ALTER TABLE workhorse.t ADD CONSTRAINT nn CHECK (c IS NOT NULL);";
    for (const rename of [
      "ALTER TABLE workhorse.t RENAME COLUMN c TO old_c;",
      "ALTER TABLE workhorse.t RENAME c TO old_c;",
      "ALTER TABLE workhorse.t RENAME CONSTRAINT nn TO kept;",
      "ALTER TABLE workhorse.t RENAME TO t_old;",
    ]) {
      const checks = noNotNullChecks();
      recordNotNullChecks(validCheck, checks);
      expect(
        exclusiveScans(
          `${rename}
ALTER TABLE workhorse.t ADD COLUMN c integer DEFAULT 0;
${setNotNull}`,
          { checks },
        ),
      ).toEqual(["sets NOT NULL on a column of workhorse.t"]);
      recordNotNullChecks(rename, checks);
      expect(exclusiveScans(setNotNull, { checks })).toEqual([
        "sets NOT NULL on a column of workhorse.t",
      ]);
    }

    const quoted = noNotNullChecks();
    recordNotNullChecks(
      'ALTER TABLE workhorse.t ADD CONSTRAINT nn CHECK ("C" IS NOT NULL);',
      quoted,
    );
    expect(exclusiveScans(setNotNull, { checks: quoted })).toEqual([
      "sets NOT NULL on a column of workhorse.t",
    ]);
    expect(
      exclusiveScans('ALTER TABLE workhorse.t ALTER COLUMN "C" SET NOT NULL;', { checks: quoted }),
    ).toEqual([]);
  });

  it("treats a table that an earlier step created in a DO block as existing", () => {
    const existing = new Set(
      createdTables("DO $$ BEGIN CREATE TABLE workhorse.o (id integer); END $$;"),
    );
    expect(
      exclusiveScans(
        `CREATE TABLE IF NOT EXISTS workhorse.o (id integer);
ALTER TABLE workhorse.o ALTER COLUMN id SET NOT NULL;`,
        { existing },
      ),
    ).toEqual(["sets NOT NULL on a column of workhorse.o"]);
  });

  it("forgets a NOT NULL check that a later step drops by a quoted name", () => {
    const checks = noNotNullChecks();
    recordNotNullChecks(
      `ALTER TABLE workhorse.t ADD CONSTRAINT "nn" CHECK (c IS NOT NULL) NOT VALID;
ALTER TABLE workhorse.t VALIDATE CONSTRAINT "nn";`,
      checks,
    );
    const setNotNull = "ALTER TABLE workhorse.t ALTER COLUMN c SET NOT NULL;";
    expect(exclusiveScans(setNotNull, { checks })).toEqual([]);
    recordNotNullChecks('ALTER TABLE workhorse.t DROP CONSTRAINT "nn";', checks);
    expect(exclusiveScans(setNotNull, { checks })).toEqual([
      "sets NOT NULL on a column of workhorse.t",
    ]);
  });

  it("accepts a table-sized change on a table the same step creates, and a constant default", () => {
    expect(
      exclusiveScans(`CREATE TABLE workhorse.n (id integer);
ALTER TABLE workhorse.n ALTER COLUMN id SET NOT NULL;
ALTER TABLE "workhorse"."n" ALTER COLUMN id TYPE bigint;
ALTER TABLE workhorse.n ADD COLUMN at timestamptz DEFAULT clock_timestamp();
ALTER TABLE t ADD COLUMN a integer NOT NULL DEFAULT 0;
ALTER TABLE t ADD COLUMN b numeric(10, 2) DEFAULT -1.5;
ALTER TABLE t ADD COLUMN c jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE t ADD COLUMN d text[] DEFAULT '{}'::text[];
ALTER TABLE t ADD COLUMN e interval DEFAULT interval '1 day';
ALTER TABLE t ADD COLUMN f timestamptz NOT NULL DEFAULT now();
ALTER TABLE t ADD COLUMN g boolean DEFAULT (false);
ALTER TABLE t ADD COLUMN h text DEFAULT NULL;
ALTER TABLE t ADD COLUMN i varchar(20) DEFAULT 'x'::character varying;
ALTER TABLE t ADD COLUMN l text DEFAULT E'hello';
DO $$ BEGIN ALTER TABLE workhorse.n ALTER COLUMN id SET NOT NULL; END $$;
ALTER TABLE t ADD COLUMN m integer DEFAULT ((0));
DO $$ BEGIN
  CREATE TABLE workhorse.o (id integer);
  ALTER TABLE workhorse.o ALTER COLUMN id SET NOT NULL;
END $$;
ALTER TABLE t ALTER COLUMN j SET DEFAULT clock_timestamp();
ALTER TABLE t ALTER COLUMN k DROP NOT NULL;
ALTER TABLE t ADD CONSTRAINT k CHECK (a IS NOT NULL) NOT VALID;`),
    ).toEqual([]);
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
    const existing = new Set(createdTables(await readFile(baseline, "utf8")));
    const checks = noNotNullChecks();
    const offenders: string[] = [];
    const files = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).toSorted();
    for (const file of files) {
      const body = await readFile(path.join(migrations, file), "utf8");
      const transactional =
        parseSchemaMigrationMetadata(file, body).execution !== "nontransactional";
      const found = transactional ? exclusiveScans(body, { existing, checks }) : [];
      for (const table of createdTables(body)) existing.add(table);
      recordNotNullChecks(body, checks);
      if (!transactional) continue;
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
