import { sql, type SQL } from "drizzle-orm";
import type { QueryResultRow } from "pg";
import type { DrizzleExecutor } from "./index.js";

const identifierPart = /[A-Za-z0-9_$\u0080-\uffff]/;
const parameter = /\$(\d+)/y;
const dollarQuote = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;
/**
 * Whitespace with a newline, and any line comments in it, up to and including the next quote. A
 * comment after the first newline must end in its own newline, so a quote inside it never matches.
 */
const literalContinuation = /[ \t\f\v]*(?:--[^\n\r]*)?[\n\r](?:[ \t\n\r\f\v]|--[^\n\r]*[\n\r])*'/y;

function continuesIdentifier(character: string | undefined): boolean {
  return character !== undefined && identifierPart.test(character);
}

/** Returns the index just past the quote that closes a literal or quoted identifier. */
function skipQuoted(text: string, start: number, quote: string, backslashEscapes: boolean): number {
  let index = start;
  while (index < text.length) {
    const character = text[index];
    if (backslashEscapes && character === "\\") {
      index += 2;
    } else if (character !== quote) {
      index += 1;
    } else if (text[index + 1] === quote) {
      index += 2;
    } else {
      return index + 1;
    }
  }
  return text.length;
}

/** Returns the index just past a block comment, which PostgreSQL lets nest. */
function skipBlockComment(text: string, start: number): number {
  let depth = 1;
  let index = start;
  while (index < text.length && depth > 0) {
    if (text.startsWith("/*", index)) {
      depth += 1;
      index += 2;
    } else if (text.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return index;
}

/**
 * Finds every positional parameter PostgreSQL would bind in `text`.
 *
 * A `$N` inside a string literal, quoted identifier, comment, or dollar-quoted body is text, not a
 * parameter, so a plpgsql function body in a schema script reaches PostgreSQL unchanged. An
 * unterminated construct runs to the end of the text, and PostgreSQL reports the syntax error.
 */
function* positionalParameters(text: string): Generator<{ index: number; text: string }> {
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "'") {
      const escapeString =
        (text[index - 1] === "E" || text[index - 1] === "e") &&
        !continuesIdentifier(text[index - 2]);
      index = skipQuoted(text, index + 1, "'", escapeString);
      // PostgreSQL joins literals separated by whitespace with a newline into one constant, and
      // the continuation keeps the first segment's escape rules.
      literalContinuation.lastIndex = index;
      while (literalContinuation.test(text)) {
        index = skipQuoted(text, literalContinuation.lastIndex, "'", escapeString);
        literalContinuation.lastIndex = index;
      }
    } else if (character === '"') {
      index = skipQuoted(text, index + 1, '"', false);
    } else if (text.startsWith("--", index)) {
      // A line comment ends at either a line feed or a carriage return.
      const lineEnd = text.slice(index + 2).search(/[\n\r]/);
      index = lineEnd === -1 ? text.length : index + 2 + lineEnd + 1;
    } else if (text.startsWith("/*", index)) {
      index = skipBlockComment(text, index + 2);
    } else if (character === "$" && !continuesIdentifier(text[index - 1])) {
      parameter.lastIndex = index;
      dollarQuote.lastIndex = index;
      const match = parameter.exec(text);
      const tag = match ? null : dollarQuote.exec(text);
      if (match) {
        yield { index, text: match[0] };
        index += match[0].length;
      } else if (tag) {
        const close = text.indexOf(tag[0], index + tag[0].length);
        index = close === -1 ? text.length : close + tag[0].length;
      } else {
        index += 1;
      }
    } else {
      index += 1;
    }
  }
}

function drizzleSql(text: string, values: readonly unknown[]): SQL {
  const chunks: Parameters<typeof sql.join>[0] = [];
  let previousIndex = 0;

  for (const match of positionalParameters(text)) {
    const placeholder = Number(match.text.slice(1));
    if (!Number.isSafeInteger(placeholder) || placeholder < 1 || placeholder > values.length) {
      throw new RangeError(`SQL placeholder ${match.text} has no matching value`);
    }
    chunks.push(
      sql.raw(text.slice(previousIndex, match.index)),
      sql.param(values[placeholder - 1]),
    );
    previousIndex = match.index + match.text.length;
  }

  chunks.push(sql.raw(text.slice(previousIndex)));
  return sql.join(chunks);
}

export async function executeDrizzle(
  executor: DrizzleExecutor,
  statement: string,
  values: readonly unknown[],
): Promise<readonly QueryResultRow[]> {
  const result: unknown = await executor.execute(drizzleSql(statement, values));
  // node-postgres returns one result per statement when a parameter-free script has several, as a
  // schema installation does. The rows of the last statement are the script's rows.
  const results = Array.isArray(result) ? result : [result];
  if (results.length === 0 || !results.every(isQueryResult)) {
    throw new TypeError("Drizzle node-postgres execute() did not return a query result");
  }
  return results.at(-1)!.rows;
}

function isQueryResult(result: unknown): result is { rows: QueryResultRow[] } {
  return (
    typeof result === "object" && result !== null && "rows" in result && Array.isArray(result.rows)
  );
}
