import { parseArgs, type ParseArgsConfig } from "node:util";

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface DatabaseOptions {
  readonly "database-url"?: string;
}

/** Which of the three inputs a database URL came from, named as the reader would set it again. */
export type DatabaseUrlSource = "--database-url" | "WORKHORSE_DATABASE_URL" | "DATABASE_URL";

/**
 * The source the running command resolved its database URL from.
 *
 * A failed connection is reported by the top-level handler, which is far from the resolution and
 * holds no options. One CLI process runs one command, so the last resolution is that command's,
 * and recording it here is what lets the failure name the input the reader would edit rather than
 * leaving them to guess which of the three won.
 */
let lastResolvedSource: DatabaseUrlSource | undefined;

/** The source {@link resolveDatabaseUrl} chose, or `undefined` before any command resolved one. */
export function resolvedDatabaseUrlSource(): DatabaseUrlSource | undefined {
  return lastResolvedSource;
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

/** Resolve every database-backed command through the packaged CLI's shared precedence order. */
export function resolveDatabaseUrl(options: DatabaseOptions): string {
  if (options["database-url"] !== undefined) {
    if (options["database-url"].length === 0) {
      throw new CliUsageError("--database-url requires a value");
    }
    lastResolvedSource = "--database-url";
    return options["database-url"];
  }
  // `??` rather than a truthiness chain: WORKHORSE_DATABASE_URL set to an empty string is a
  // deliberate value that wins and then fails the check below, rather than falling through to
  // DATABASE_URL and connecting somewhere the operator did not name.
  const preferred = process.env.WORKHORSE_DATABASE_URL;
  const url = preferred ?? process.env.DATABASE_URL;
  if (!url) {
    throw new CliUsageError(
      "No database URL. Pass --database-url, or set WORKHORSE_DATABASE_URL or DATABASE_URL.",
    );
  }
  lastResolvedSource = preferred === undefined ? "DATABASE_URL" : "WORKHORSE_DATABASE_URL";
  return url;
}
