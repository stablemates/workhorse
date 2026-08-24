import { SQL_STATEMENTS } from "./queue/sql-catalogue.generated.js";
import type { Queryable } from "./types.js";

/**
 * The supported-version contract for the published packages.
 *
 * These constants are the single source of truth behind the CI matrix, the package `engines`
 * fields, and the compatibility documentation. `test/support-matrix.test.ts` fails when any of
 * those drift away from this module, so a version can only be claimed as supported once it is
 * actually exercised.
 *
 * "Supported" here means tested in CI on every change. It is deliberately narrower than the
 * versions Workhorse is likely to run on, and narrower still than the single configuration used
 * for recorded benchmark evidence. See `docs/compatibility.md`.
 */

/** Lowest Node.js major the packages declare in `engines` and run in CI. */
export const MINIMUM_NODE_MAJOR = 22;

/** Node.js majors exercised by CI. Odd-numbered development lines are never included. */
export const SUPPORTED_NODE_MAJORS: readonly number[] = [22, 24];

/**
 * JS runtimes exercised only by CI's `runtime-smoke` lane, never claimed as supported.
 *
 * The lane runs `test/runtime-smoke.ts` — an enqueue, claim, and complete round-trip through the
 * built package against PostgreSQL — under the latest release of each runtime. Nothing more: the
 * full vitest suites run under Node.js only, so a regression that only these runtimes can show
 * outside that round-trip is not caught. See the JS runtime smoke tier in `docs/compatibility.md`.
 */
export const SMOKE_TESTED_JS_RUNTIMES: readonly string[] = ["bun", "deno"];

/** Lowest PostgreSQL major the schema installs against. Below this, installation is refused. */
export const MINIMUM_POSTGRES_MAJOR = 15;

/** PostgreSQL majors exercised by CI. */
export const SUPPORTED_POSTGRES_MAJORS: readonly number[] = [15, 16, 17, 18];

export interface PostgresSupport {
  /** Server major version, for example `17`. */
  readonly major: number;
  /** Server version as PostgreSQL reports it, for example `17.2 (Debian 17.2-1)`. */
  readonly version: string;
  /** The server meets the minimum this schema requires. */
  readonly supported: boolean;
  /** The server major is one CI exercises on every change. */
  readonly tested: boolean;
}

/**
 * Classify a server from `server_version_num`, which encodes major and minor as `major * 10000 +
 * minor` from PostgreSQL 10 onward.
 *
 * A server newer than the tested majors is reported as supported but untested rather than
 * rejected: refusing to run on a release that did not exist when a version of Workhorse was
 * published would strand callers on every PostgreSQL upgrade.
 */
export function describePostgresSupport(
  serverVersionNumber: number,
  version: string,
): PostgresSupport {
  const major = Math.floor(serverVersionNumber / 10_000);
  return {
    major,
    version,
    supported: major >= MINIMUM_POSTGRES_MAJOR,
    tested: SUPPORTED_POSTGRES_MAJORS.includes(major),
  };
}

/** Read the connected server's version without creating or changing any database object. */
export async function readPostgresSupport(database: Queryable): Promise<PostgresSupport> {
  const result = await database.query<{ number: string; version: string }>(
    SQL_STATEMENTS["postgres_support"],
  );
  const row = result.rows[0];
  if (!row) throw new Error("PostgreSQL did not report a server version");
  return describePostgresSupport(Number(row.number), row.version);
}

/**
 * Refuse to proceed against a PostgreSQL older than the schema requires.
 *
 * This runs before installation rather than at claim time. The failure a caller would otherwise
 * see is a syntax or feature error from deep inside `schema.sql`, which reads as a Workhorse bug
 * rather than an unsupported database.
 */
export async function assertSupportedPostgres(database: Queryable): Promise<void> {
  const support = await readPostgresSupport(database);
  if (support.supported) return;
  throw new Error(
    `Workhorse requires PostgreSQL ${MINIMUM_POSTGRES_MAJOR} or newer. This server reports ${support.version}.`,
  );
}
