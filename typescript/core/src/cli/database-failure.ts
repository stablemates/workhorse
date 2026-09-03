import type { DatabaseUrlSource } from "./arguments.js";

/**
 * Turn a failed connection into the sentence the reader can act on.
 *
 * An unreachable or wrong database URL is the most likely first mistake on a host installing
 * Workhorse, and the top-level handler used to answer it with six frames of `node_modules`
 * internals. The frames say nothing a reader can use: the fault is in the URL, not in the stack,
 * and the stack does not say which of the three sources the URL came from.
 *
 * Only this class is rewritten. Anything unrecognised keeps its stack, because a stack is the right
 * answer for a defect in this project and the wrong answer for a typo in a connection string.
 *
 * The URL itself is never printed. It routinely carries a password, and a CLI that echoes one into
 * a terminal has put it into shell history and CI logs. Host and port are printed when the failure
 * carries them, because they are what makes the sentence actionable and neither is a credential.
 */

/** Socket and DNS failures: the database was never reached. */
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

/**
 * PostgreSQL answered and refused. Class 08 is connection exception, 28 is authorization, and
 * `3D000` is a database name that does not exist. All three mean the URL is wrong rather than that
 * Workhorse is broken, so all three earn a sentence instead of a stack.
 */
function isRefusalSqlState(code: string): boolean {
  return code.startsWith("08") || code.startsWith("28") || code === "3D000";
}

interface ErrorShape {
  readonly code?: unknown;
  readonly address?: unknown;
  readonly port?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
  readonly errors?: unknown;
}

function shapeOf(error: unknown): ErrorShape | undefined {
  return error && typeof error === "object" ? (error as ErrorShape) : undefined;
}

/**
 * The failures a single connection attempt can carry, outermost first.
 *
 * Node's happy-eyeballs dialling reports every attempted address as one `AggregateError`, and a
 * driver may wrap either that or a bare socket error in a `cause`. Walking both means one shape
 * check handles all three rather than only the one a given driver and Node version happened to
 * produce.
 */
function* candidates(error: unknown, seen = new Set<unknown>()): Generator<ErrorShape> {
  if (!error || seen.has(error)) return;
  seen.add(error);
  const shape = shapeOf(error);
  if (!shape) return;
  yield shape;
  if (Array.isArray(shape.errors)) {
    for (const nested of shape.errors) yield* candidates(nested, seen);
  }
  yield* candidates(shape.cause, seen);
}

/** `127.0.0.1:5432` when the failure names an address, otherwise nothing. */
function addressOf(shape: ErrorShape): string | undefined {
  if (typeof shape.address !== "string" || shape.address === "") return undefined;
  return typeof shape.port === "number" ? `${shape.address}:${shape.port}` : shape.address;
}

/** Where the reader should look, phrased as the thing they would edit. */
function sourceSentence(source: DatabaseUrlSource | undefined): string {
  if (source === undefined) return "";
  const where = source === "--database-url" ? "the --database-url option" : `$${source}`;
  return ` The database URL came from ${where}.`;
}

/**
 * One sentence for a connection this CLI could not use, or `undefined` to let the stack through.
 *
 * The caller decides what to do with `undefined`; this function only classifies, so the top-level
 * handler keeps one place that writes to stderr and sets an exit code.
 */
export function describeDatabaseFailure(
  error: unknown,
  source: DatabaseUrlSource | undefined,
): string | undefined {
  for (const shape of candidates(error)) {
    const code = typeof shape.code === "string" ? shape.code : undefined;
    if (code === undefined) continue;

    if (UNREACHABLE_CODES.has(code)) {
      const at = addressOf(shape);
      return (
        `Could not reach PostgreSQL${at ? ` at ${at}` : ""} (${code}).` + sourceSentence(source)
      );
    }
    if (isRefusalSqlState(code)) {
      const message = typeof shape.message === "string" ? shape.message : "connection refused";
      return `PostgreSQL refused the connection: ${message} (${code}).` + sourceSentence(source);
    }
  }
  return undefined;
}
