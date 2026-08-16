import { WORKHORSE_SCHEMA_VERSION } from "../schema.js";
import { MINIMUM_POSTGRES_MAJOR, type PostgresSupport } from "../support.js";

export interface SchemaStatusReport {
  readonly schema: {
    readonly installedVersion: number | null;
    readonly expectedVersion: number;
    readonly state: "not-installed" | "current" | "drift";
  };
  readonly postgres: PostgresSupport & {
    readonly minimumMajor: number;
    readonly level: "unsupported" | "supported-untested" | "supported-tested";
  };
}

export function createSchemaStatusReport(
  installedVersion: number | null,
  support: PostgresSupport,
): SchemaStatusReport {
  return {
    schema: {
      installedVersion,
      expectedVersion: WORKHORSE_SCHEMA_VERSION,
      state:
        installedVersion === null
          ? "not-installed"
          : installedVersion === WORKHORSE_SCHEMA_VERSION
            ? "current"
            : "drift",
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
