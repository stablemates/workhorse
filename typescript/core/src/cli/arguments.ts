import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  isLocalDatabasePurpose,
  localDatabaseUrl,
  type LocalDatabasePurpose,
} from "../local-database.js";

export const USAGE_EXIT_CODE = 64;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export const databaseOptionDefinitions = {
  "database-url": { type: "string" },
  database: { type: "string" },
} as const;

export interface DatabaseOptions {
  readonly "database-url"?: string;
  readonly database?: string;
}

/** Parse one command's declared options and replace Node's parser text with stable CLI messages. */
export function parseCommandArgs<const T extends ParseArgsConfig>(
  command: string,
  config: T,
): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    const message = error instanceof Error ? error.message : String(error);
    const option = message.match(/'(--?[\w-]+)/)?.[1];
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      throw new CliUsageError(`Unknown ${command} option: ${option ?? "option"}`);
    }
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      throw new CliUsageError(option ? `${option} requires a value` : `Invalid ${command} option`);
    }
    if (code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") {
      const positional = message.match(/'([^']+)'/)?.[1];
      throw new CliUsageError(`Unexpected ${command} argument: ${positional ?? "argument"}`);
    }
    throw new CliUsageError(`Invalid ${command} arguments`);
  }
}

/**
 * Resolve a database for all CLI commands. An explicit local purpose exists for repository scripts;
 * application commands otherwise use the shared packaged-CLI environment order.
 */
export function resolveDatabaseUrl(
  options: DatabaseOptions,
  defaultPurpose?: LocalDatabasePurpose,
): string {
  if (options["database-url"]) return options["database-url"];
  if (options.database !== undefined) {
    if (!isLocalDatabasePurpose(options.database)) {
      throw new CliUsageError("--database must be dev, test, bench, or demo");
    }
    return localDatabaseUrl(options.database);
  }
  const url =
    process.env.WORKHORSE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    (defaultPurpose ? localDatabaseUrl(defaultPurpose) : undefined);
  if (!url) {
    throw new CliUsageError(
      "No database URL. Pass --database-url, select --database, or set WORKHORSE_DATABASE_URL or DATABASE_URL.",
    );
  }
  return url;
}
