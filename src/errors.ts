/**
 * The error vocabulary every Workhorse package shares.
 *
 * Two problems live here. The first is recognition: a caller who wants to handle "anything
 * Workhorse threw" should not have to enumerate sixteen class names, so every error this
 * library throws deliberately extends {@link WorkhorseError}. The second is extraction: a
 * PostgreSQL error reaches us wrapped in whatever the caller's ORM wraps it in, so reading a
 * SQLSTATE or a `DETAIL` payload means walking a chain someone else built.
 *
 * `databaseErrorCode()` and `databaseErrorDetails()` are the only two walkers. They are
 * breadth-first over `cause`, `driverError`, and `meta`, bounded in both visit count and cycle
 * exposure, because the ORM packages nest those keys in different orders and a cyclic `cause`
 * is a real shape a driver can produce.
 */

/** Longest wrapper chain either walker inspects before giving up. */
const MAX_ERROR_WRAPPERS = 16;

/** PostgreSQL SQLSTATE: five characters drawn from digits and uppercase letters. */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/** Keys an ORM uses to hang the underlying driver error off its own wrapper. */
const WRAPPER_KEYS = ["cause", "driverError", "meta"] as const;

/**
 * Base class for every error Workhorse throws on purpose.
 *
 * Extending this does not change what a caller catches today — each subclass keeps its own name
 * and fields — it only adds one type that `instanceof` can test when the specific class does not
 * matter. Errors that escape from PostgreSQL or from a caller's handler are not converted to this
 * base; they stay whatever they were, so `instanceof WorkhorseError` means "Workhorse decided
 * this", not "this happened during a Workhorse call".
 */
export class WorkhorseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkhorseError";
  }
}

/**
 * Visit an error and the errors it wraps, nearest first, at most {@link MAX_ERROR_WRAPPERS}
 * objects. The `seen` set stops a cyclic `cause` from spinning; the queue is breadth-first so a
 * shallow wrapper cannot hide behind a deeply nested one.
 */
function* wrappedErrors(error: unknown): Generator<Record<string, unknown>> {
  const pending: unknown[] = [error];
  const seen = new Set<object>();

  for (let visited = 0; pending.length > 0 && visited < MAX_ERROR_WRAPPERS;) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    visited += 1;
    const record = current as Record<string, unknown>;
    yield record;
    for (const key of WRAPPER_KEYS) {
      if (key in record) pending.push(record[key]);
    }
  }
}

/**
 * Read the SQLSTATE PostgreSQL reported, through any ORM wrapper that carried it.
 *
 * The shape check matters as much as the traversal. Prisma reports its own `P2010`-style codes on
 * the same `code` field, and those share the five-character shape, so a caller comparing against a
 * Workhorse SQLSTATE such as `P1001` would otherwise match the wrong error. Prisma keeps the real
 * SQLSTATE on `meta`, which this walker visits, and a nested match wins because a P-code is only
 * returned once nothing else in the chain supplied one.
 */
export function databaseErrorCode(error: unknown): string | undefined {
  let prismaCode: string | undefined;

  for (const wrapper of wrappedErrors(error)) {
    const code = wrapper.code;
    if (typeof code !== "string" || !SQLSTATE_PATTERN.test(code)) continue;
    if (/^P\d{4}$/.test(code) && wrapper.meta !== undefined) prismaCode ??= code;
    else return code;
  }

  return prismaCode;
}

/**
 * Read every `DETAIL` payload PostgreSQL attached along the wrapper chain, nearest first.
 *
 * Workhorse encodes conflict diagnostics as JSON in `DETAIL`. All of them are returned rather
 * than the nearest one, because the caller validates the parsed shape and an ORM wrapper can
 * carry its own unrelated `detail` string in front of the one PostgreSQL wrote. The caller parses
 * and validates, because only the caller knows which shape it expects, and an unrecognized shape
 * has to degrade to sanitized defaults rather than propagate.
 */
export function databaseErrorDetails(error: unknown): string[] {
  const details: string[] = [];
  for (const wrapper of wrappedErrors(error)) {
    if (typeof wrapper.detail === "string") details.push(wrapper.detail);
  }
  return details;
}

/** A query that must return exactly one row returned none. */
export class MissingRowError extends WorkhorseError {
  constructor(readonly source: string) {
    super(`${source} returned no rows`);
    this.name = "MissingRowError";
  }
}

/**
 * Take the single row a statement is defined to return.
 *
 * Every set-returning function in `sql/schema.sql` that this is used with returns exactly one row,
 * so an empty result means the schema and this client disagree — usually a partial upgrade. The
 * non-null assertion it replaces turned that into a `TypeError` about an undefined property three
 * lines later, naming neither the statement nor the real cause.
 */
export function expectOneRow<TRow>(
  result: { readonly rows: readonly TRow[] },
  source: string,
): TRow {
  const row = result.rows[0];
  if (row === undefined) throw new MissingRowError(source);
  return row;
}
