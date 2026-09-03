/**
 * Read the governed SQL surface out of `sql/schema/current.sql` without a database.
 *
 * `pnpm sql-catalogues:check` runs in the CI `static` job, which has no PostgreSQL service, so the
 * surface is parsed from the committed schema text rather than introspected. The parser only has to
 * understand the statement forms this schema actually uses; `scripts/sql-surface.test.ts` fails when
 * a table, view, or function stops being recognised.
 */

export interface FunctionArgument {
  name: string;
  type: string;
  optional: boolean;
}

export interface FunctionDefinition {
  name: string;
  arguments: FunctionArgument[];
  returns: string;
}

export interface RelationDefinition {
  name: string;
  kind: "table" | "view";
  columns: Map<string, string>;
}

export interface SqlSchema {
  functions: Map<string, FunctionDefinition[]>;
  relations: Map<string, RelationDefinition>;
}

const COLUMN_CONSTRAINT_KEYWORDS = new Set([
  "not",
  "null",
  "default",
  "primary",
  "unique",
  "references",
  "check",
  "generated",
  "collate",
  "constraint",
  "storage",
  "compression",
]);

const TABLE_CONSTRAINT_KEYWORDS = new Set([
  "constraint",
  "primary",
  "unique",
  "foreign",
  "check",
  "exclude",
  "like",
]);

/**
 * Split a SQL script into top-level statements, ignoring `;` inside dollar-quoted function bodies,
 * string literals, and comments. Function bodies contain their own `CREATE TABLE`, so a parser that
 * skipped this step would report partitions created at runtime as schema relations.
 */
export function topLevelStatements(source: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "-" && source[index + 1] === "-") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (character === "'") {
      index += 1;
      while (index < source.length) {
        if (source[index] === "'" && source[index + 1] === "'") index += 2;
        else if (source[index] === "'") break;
        else index += 1;
      }
      index += 1;
      continue;
    }
    if (character === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(source.slice(index));
      if (tag !== null) {
        const end = source.indexOf(tag[0], index + tag[0].length);
        index = end === -1 ? source.length : end + tag[0].length;
        continue;
      }
    }
    if (character === ";") {
      statements.push(source.slice(start, index));
      index += 1;
      start = index;
      continue;
    }
    index += 1;
  }
  const tail = source.slice(start).trim();
  if (tail.length > 0) statements.push(tail);
  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Read a capture group the matched pattern always fills. */
function captured(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new Error(`pattern matched ${match[0]} without group ${index}`);
  return value;
}

/** Strip `--` comments so a keyword scan never matches commentary. */
function withoutComments(statement: string): string {
  return statement.replaceAll(/--[^\n]*/g, "");
}

/** Return the text between `open` at `from` and its matching close parenthesis. */
function balanced(text: string, from: number): { body: string; end: number } | null {
  if (text[from] !== "(") return null;
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(from + 1, index), end: index };
    }
  }
  return null;
}

/** Split on commas that sit outside parentheses. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function normalizeType(type: string): string {
  return type.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

/** Read a `name type` pair, stopping the type before the first column-constraint keyword. */
function readNameAndType(text: string): { name: string; type: string } | null {
  const tokens = text.trim().split(/\s+/);
  const name = tokens.shift();
  if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  const typeTokens: string[] = [];
  for (const token of tokens) {
    if (typeTokens.length > 0 && COLUMN_CONSTRAINT_KEYWORDS.has(token.toLowerCase())) break;
    typeTokens.push(token);
  }
  if (typeTokens.length === 0) return null;
  return { name, type: normalizeType(typeTokens.join(" ")) };
}

function parseTable(
  statement: string,
  relations: Map<string, RelationDefinition>,
): RelationDefinition | null {
  const header = /^CREATE TABLE (?:IF NOT EXISTS )?workhorse\.([a-z0-9_]+)\s*\(/i.exec(statement);
  if (header === null) return null;
  const parenthesis = balanced(statement, header[0].length - 1);
  if (parenthesis === null) return null;
  const columns = new Map<string, string>();
  for (const item of splitTopLevel(parenthesis.body)) {
    // `LIKE workhorse.other` copies the whole column list, so the copy must inherit it too.
    const like = /^LIKE\s+workhorse\.([a-z0-9_]+)/i.exec(item);
    if (like !== null) {
      for (const [column, type] of relations.get(captured(like, 1))?.columns ?? [])
        columns.set(column, type);
      continue;
    }
    const first = item.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (TABLE_CONSTRAINT_KEYWORDS.has(first)) continue;
    const column = readNameAndType(item);
    if (column !== null) columns.set(column.name, column.type);
  }
  return { name: captured(header, 1), kind: "table", columns };
}

interface ViewSource {
  targets: string[];
  aliases: Map<string, string>;
}

/** Read a view's projected expressions and its `FROM`/`JOIN` alias map. */
function parseViewSource(body: string): ViewSource | null {
  const select = /\bSELECT\b/i.exec(body);
  if (select === null) return null;
  const after = body.slice(select.index + select[0].length);
  let depth = 0;
  let fromIndex = after.length;
  for (const match of after.matchAll(/[()]|\bFROM\b/gi)) {
    if (match[0] === "(") depth += 1;
    else if (match[0] === ")") depth -= 1;
    else if (depth === 0) {
      fromIndex = match.index;
      break;
    }
  }
  const aliases = new Map<string, string>();
  for (const match of after
    .slice(fromIndex)
    .matchAll(/workhorse\.([a-z0-9_]+)(\s+([a-z][a-z0-9_]*))?/gi)) {
    const relation = match[1] ?? "";
    const alias = match[3]?.toLowerCase();
    aliases.set(relation, relation);
    if (
      alias !== undefined &&
      !["on", "join", "where", "and", "or", "left", "inner"].includes(alias)
    )
      aliases.set(alias, relation);
  }
  return { targets: splitTopLevel(after.slice(0, fromIndex)), aliases };
}

/** Name the column a projected expression produces, following PostgreSQL's own rules. */
function projectedName(target: string): string | null {
  const alias = /\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(target);
  if (alias !== null) return captured(alias, 1);
  const bare = /^[A-Za-z_][A-Za-z0-9_.]*$/.exec(target.trim());
  if (bare === null) return null;
  return target.trim().split(".").at(-1) ?? null;
}

/** Resolve a projected expression to a SQL type using the relations it reads. */
function projectedType(
  target: string,
  source: ViewSource,
  relations: Map<string, RelationDefinition>,
  functions: Map<string, FunctionDefinition[]>,
): string {
  const call = /^workhorse\.([a-z0-9_]+)\s*\(/i.exec(target.trim());
  if (call !== null) return functions.get(captured(call, 1))?.[0]?.returns ?? "unknown";
  const bare =
    /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)|^([A-Za-z_][A-Za-z0-9_]*)$/.exec(
      target.trim(),
    );
  if (bare === null) return "unknown";
  const [, qualifier, qualified, unqualified] = bare;
  if (qualifier !== undefined && qualified !== undefined) {
    const relation = source.aliases.get(qualifier.toLowerCase());
    return relations.get(relation ?? "")?.columns.get(qualified) ?? "unknown";
  }
  for (const relation of new Set(source.aliases.values())) {
    const type = relations.get(relation)?.columns.get(unqualified ?? "");
    if (type !== undefined) return type;
  }
  return "unknown";
}

function parseView(
  statement: string,
  relations: Map<string, RelationDefinition>,
  functions: Map<string, FunctionDefinition[]>,
): RelationDefinition | null {
  const header = /^CREATE (?:OR REPLACE )?VIEW workhorse\.([a-z0-9_]+)\s+AS\b/i.exec(statement);
  if (header === null) return null;
  const source = parseViewSource(statement.slice(header[0].length));
  if (source === null) return null;
  const columns = new Map<string, string>();
  for (const target of source.targets) {
    const name = projectedName(target);
    if (name === null) continue;
    columns.set(name, projectedType(target, source, relations, functions));
  }
  return { name: captured(header, 1), kind: "view", columns };
}

function parseFunction(statement: string): FunctionDefinition | null {
  const header = /^CREATE (?:OR REPLACE )?FUNCTION workhorse\.([a-z0-9_]+)\s*\(/i.exec(statement);
  if (header === null) return null;
  const parenthesis = balanced(statement, header[0].length - 1);
  if (parenthesis === null) return null;
  const args: FunctionArgument[] = [];
  for (const item of splitTopLevel(parenthesis.body)) {
    const [declaration = "", ...defaultParts] = item.split(/\s+DEFAULT\s+/i);
    const argument = readNameAndType(declaration);
    if (argument === null) continue;
    args.push({ ...argument, optional: defaultParts.length > 0 });
  }
  const rest = statement.slice(parenthesis.end + 1);
  const returns = /\bRETURNS\s+/i.exec(rest);
  if (returns === null) return null;
  const afterReturns = rest.slice(returns.index + returns[0].length);
  const table = /^(SETOF\s+)?TABLE\s*\(/i.exec(afterReturns);
  if (table !== null) {
    const columns = balanced(afterReturns, table[0].length - 1);
    if (columns === null) return null;
    const fields = splitTopLevel(columns.body)
      .map((item) => readNameAndType(item))
      .filter((item) => item !== null)
      .map((item) => `${item.name} ${item.type}`);
    return { name: captured(header, 1), arguments: args, returns: `table(${fields.join(", ")})` };
  }
  const scalar = /^[A-Za-z_][A-Za-z0-9_.]*(\s*\[\s*\])?/.exec(afterReturns.trim());
  if (scalar === null) return null;
  const setof = /^SETOF\s+([A-Za-z_][A-Za-z0-9_.]*(\s*\[\s*\])?)/i.exec(afterReturns.trim());
  return {
    name: captured(header, 1),
    arguments: args,
    returns: normalizeType(setof === null ? captured(scalar, 0) : `setof ${captured(setof, 1)}`),
  };
}

/** Parse every top-level table, view, and function the schema script installs. */
export function parseSqlSchema(source: string): SqlSchema {
  const functions = new Map<string, FunctionDefinition[]>();
  const relations = new Map<string, RelationDefinition>();
  const viewStatements: string[] = [];
  for (const raw of topLevelStatements(source)) {
    const statement = withoutComments(raw).trim();
    const table = parseTable(statement, relations);
    if (table !== null) {
      relations.set(table.name, table);
      continue;
    }
    const definition = parseFunction(statement);
    if (definition !== null) {
      const overloads = functions.get(definition.name) ?? [];
      overloads.push(definition);
      functions.set(definition.name, overloads);
      continue;
    }
    if (/^CREATE (?:OR REPLACE )?VIEW workhorse\./i.test(statement)) viewStatements.push(statement);
  }
  // Views resolve their column types against the tables and functions they read, so they are parsed
  // after both. No view in this schema reads another view.
  for (const statement of viewStatements) {
    const view = parseView(statement, relations, functions);
    if (view !== null) relations.set(view.name, view);
  }
  return { functions, relations };
}
