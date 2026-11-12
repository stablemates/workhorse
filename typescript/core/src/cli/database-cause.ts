import { DatabaseError } from "pg";

/**
 * Show the PostgreSQL error under a wrapped failure, so an operator can act on it.
 *
 * `applySchemaMigrationPlan` throws `Workhorse migration <file> failed and was rolled back`, or the
 * `failed part-way` form for a non-transactional step, and keeps the driver error as its `cause`.
 * The stack of the outer error names the step but not the reason. The reason is in the PostgreSQL
 * message, its SQLSTATE, its DETAIL, and its HINT. For example, the guard of migration 0102 puts the
 * `DROP INDEX CONCURRENTLY` statement that repairs an invalid index in its message.
 *
 * The lines go after the output of the outer error, so its first line stays the same for a script
 * that matches it.
 *
 * Only an error that the driver made gives these fields. A `DatabaseError` holds what the server
 * sent about one statement. It holds no connection URL, no connection parameter, and no environment
 * value, and this function reads no other field. Outside a migration step, a failure that
 * `describeDatabaseFailure` recognizes never reaches this function: a socket error, or a SQLSTATE
 * that starts with 08 or 28, or 3D000. A failed migration step reaches it with each SQLSTATE, so
 * the output names the step also when the session ended under it (SM-2048).
 */

/** How far the walk follows `cause`. A real chain is one or two links long. */
const MAXIMUM_CAUSE_DEPTH = 8;

/** The fields of the first driver error under `error`, or `undefined` when there is none. */
function findDriverCause(error: unknown): DatabaseError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; depth < MAXIMUM_CAUSE_DEPTH; depth += 1) {
    if (current === undefined || current === null || seen.has(current)) return undefined;
    seen.add(current);
    if (current instanceof DatabaseError) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/**
 * Remove terminal control characters from text that the server sent.
 *
 * A message can quote data, and a control sequence in that data must not change the terminal. A
 * line break stays, and each continuation line gets the indent of its field.
 */
function printable(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- the class names the characters to remove.
      .replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
      .trimEnd()
      .replaceAll("\n", "\n  ")
  );
}

/** The text that takes the place of a field that can quote stored data. */
const WITHHELD = "withheld, because it can quote the values of a row or an input";

/**
 * Which fields of this SQLSTATE can quote stored data, so the CLI does not print them.
 *
 * A row of a Workhorse table can hold a task payload, a payload can hold a credential, and the
 * output of a schema command often goes to a deployment log. Class 22 (data exception) quotes the
 * input in its message, for example `invalid input syntax for type integer: "<value>"`, and in
 * its DETAIL. Class 23 (integrity constraint violation) names only the constraint in its message,
 * but writes `Failing row contains (...)` or `Key (...)=(...)` in its DETAIL. For both classes the
 * HINT is withheld too. The SQLSTATE always shows, and the server log keeps the full error.
 */
function withheldFields(sqlState: string | undefined): {
  readonly message: boolean;
  readonly detailAndHint: boolean;
} {
  const dataException = sqlState?.startsWith("22") === true;
  return {
    message: dataException,
    detailAndHint: dataException || sqlState?.startsWith("23") === true,
  };
}

/**
 * The lines that describe the PostgreSQL cause of `error`, each ending in a line break, or
 * `undefined` when no error in the bounded `cause` chain came from the driver.
 */
export function describeDatabaseCause(error: unknown): string | undefined {
  const cause = findDriverCause(error);
  if (cause === undefined) return undefined;
  const sqlState = typeof cause.code === "string" && cause.code !== "" ? cause.code : undefined;
  const withheld = withheldFields(sqlState);
  const message = withheld.message ? WITHHELD : printable(cause.message);
  const lines = [
    `Cause: ${message}${sqlState === undefined ? "" : ` (SQLSTATE ${printable(sqlState)})`}`,
  ];
  if (typeof cause.detail === "string" && cause.detail !== "") {
    lines.push(`Detail: ${withheld.detailAndHint ? WITHHELD : printable(cause.detail)}`);
  }
  if (typeof cause.hint === "string" && cause.hint !== "") {
    lines.push(`Hint: ${withheld.detailAndHint ? WITHHELD : printable(cause.hint)}`);
  }
  return `${lines.join("\n")}\n`;
}
