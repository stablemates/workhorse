import {
  MINIMUM_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  schemaCompatibilityRefusal,
  WORKHORSE_SCHEMA_VERSION,
} from "../schema.js";
import { MINIMUM_POSTGRES_MAJOR, type PostgresSupport } from "../support.js";
import type { SchemaCompatibilityCode } from "../errors.js";

export interface SchemaStatusReport {
  readonly schema: {
    readonly installedVersion: number | null;
    readonly expectedVersion: number;
    readonly minimumVersion: number;
    readonly clientProtocolVersion: number;
    readonly installedProtocolVersions: readonly number[] | null;
    /** Where the installed version sits relative to this build. Says nothing about acceptance. */
    readonly state: "not-installed" | "behind" | "current" | "ahead";
    /** Whether this build would start against the installed schema. */
    readonly compatible: boolean;
    /** Why it would refuse, in the words the runtime itself uses. `null` when compatible. */
    readonly refusal: string | null;
    /** The same refusal as the code `SchemaCompatibilityError` carries. `null` when compatible. */
    readonly refusalCode: SchemaCompatibilityCode | null;
  };
  readonly postgres: PostgresSupport & {
    readonly minimumMajor: number;
    readonly level: "unsupported" | "supported-untested" | "supported-tested";
  };
}

/**
 * Report the installed schema as two independent facts: where it sits, and whether this build
 * accepts it.
 *
 * Those were one field until 0.1.0, when a migration became something a running deployment applies
 * rather than a reason to recreate the database. A schema ahead of this build is now the normal
 * middle of a rolling upgrade, because inside a major line a migration only adds
 * ([ADR 0053](../../../../docs/decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md)).
 * A deployment gate reads `compatible`; an operator asking what happened reads `state`.
 */
export function createSchemaStatusReport(
  installedVersion: number | null,
  installedProtocolVersions: readonly number[] | null,
  support: PostgresSupport,
): SchemaStatusReport {
  // A missing schema reaches the CLI as a missing relation rather than an ambiguous row, so it
  // gets the sentence that names the step an operator has not run yet.
  const refusal =
    installedVersion === null
      ? {
          code: "schema-not-installed" as const,
          message:
            "No Workhorse schema is installed. Run the schema installation step before starting this release.",
        }
      : schemaCompatibilityRefusal({
          schemaVersion: installedVersion,
          servedProtocolVersions: installedProtocolVersions ?? [],
        });
  return {
    schema: {
      installedVersion,
      expectedVersion: WORKHORSE_SCHEMA_VERSION,
      minimumVersion: MINIMUM_SCHEMA_VERSION,
      clientProtocolVersion: PROTOCOL_VERSION,
      installedProtocolVersions,
      state:
        installedVersion === null
          ? "not-installed"
          : installedVersion < WORKHORSE_SCHEMA_VERSION
            ? "behind"
            : installedVersion > WORKHORSE_SCHEMA_VERSION
              ? "ahead"
              : "current",
      compatible: refusal === null,
      refusal: refusal === null ? null : refusal.message,
      refusalCode: refusal === null ? null : refusal.code,
    },
    postgres: {
      ...support,
      minimumMajor: MINIMUM_POSTGRES_MAJOR,
      level: !support.supported
        ? "unsupported"
        : support.tested
          ? "supported-tested"
          : "supported-untested",
    },
  };
}
