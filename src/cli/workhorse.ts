#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { installSchema, readSchemaVersion, WORKHORSE_SCHEMA_VERSION } from "../schema.js";
import { MINIMUM_POSTGRES_MAJOR, readPostgresSupport } from "../support.js";
import { runWorkerProcess } from "../worker-process.js";
import type { WorkerProcessDefinition } from "../worker-process.js";
import { startDashboardServer } from "./dashboard.js";
import { initializeProject } from "./init.js";

const USAGE = `Usage:
  workhorse init [--dir <path>] [--force]
  workhorse dashboard [--port <port>] [--host <interface>] [--allow-mutations] [--actor <name>]
  workhorse schema install [--database-url <url>]
  workhorse schema status [--database-url <url>]
  workhorse worker --config <compiled-module> [--shutdown-timeout-ms <milliseconds>]
  workhorse --help

Commands:
  dashboard  Serve the operator dashboard as its own process against any Workhorse database.
  init    Detect the project and scaffold a worker configuration for an existing application.
  schema  Install the Workhorse schema into a clean database, or report the installed version.
  worker  Load a default-exported worker process definition and run it until shutdown.

The database URL is read from --database-url, then WORKHORSE_DATABASE_URL, then DATABASE_URL.

The dashboard binds 127.0.0.1 and is read-only unless told otherwise. It performs no authentication,
so --host and --allow-mutations publish an unauthenticated control surface and warn when used.

The worker configuration must be JavaScript that the current Node.js process can import. Compile
TypeScript configuration files before invoking the packaged CLI.
`;

interface WorkerCommandOptions {
  config: string;
  shutdownTimeoutMs?: number;
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive safe integer`);
  }
  return parsed;
}

function parseWorkerOptions(args: readonly string[]): WorkerCommandOptions {
  const config = valueAfter(args, "--config");
  if (!config) throw new Error("worker requires --config <compiled-module>");
  const timeout = valueAfter(args, "--shutdown-timeout-ms");
  const recognized = new Set(["--config", "--shutdown-timeout-ms"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (!argument.startsWith("--")) throw new Error(`Unexpected worker argument: ${argument}`);
    if (!recognized.has(argument)) throw new Error(`Unknown worker option: ${argument}`);
    index += 1;
  }
  return {
    config,
    shutdownTimeoutMs:
      timeout === undefined ? undefined : parsePositiveInteger(timeout, "--shutdown-timeout-ms"),
  };
}

function isWorkerProcessDefinition(value: unknown): value is WorkerProcessDefinition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkerProcessDefinition>;
  return typeof candidate.adapter === "function" && Array.isArray(candidate.workers);
}

async function loadDefinition(configPath: string): Promise<WorkerProcessDefinition> {
  const absolutePath = path.resolve(process.cwd(), configPath);
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to import worker configuration at ${absolutePath}`, { cause: error });
  }
  if (!isWorkerProcessDefinition(module.default)) {
    throw new Error(
      `Worker configuration at ${absolutePath} must default-export defineWorkerProcess({...})`,
    );
  }
  return module.default;
}

function resolveDatabaseUrl(args: readonly string[]): string {
  const url =
    valueAfter(args, "--database-url") ??
    process.env.WORKHORSE_DATABASE_URL ??
    process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "No database URL. Pass --database-url, or set WORKHORSE_DATABASE_URL or DATABASE_URL.",
    );
  }
  return url;
}

async function runSchemaCommand(args: readonly string[]): Promise<void> {
  const action = args[0];
  if (action !== "install" && action !== "status") {
    throw new Error(`Unknown schema command: ${String(action)}\n\n${USAGE}`);
  }
  const databaseUrl = resolveDatabaseUrl(args.slice(1));
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    if (action === "status") {
      // A database with no Workhorse schema is a normal answer to "status", not a failure, so the
      // missing-relation and missing-schema codes are reported rather than thrown.
      const version = await readSchemaVersion(pool).catch((error: unknown) => {
        const code =
          error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
        if (code === "42P01" || code === "3F000") return null;
        throw error;
      });
      process.stdout.write(
        version === null
          ? `No Workhorse schema is installed. Runtime expects v${WORKHORSE_SCHEMA_VERSION}.\n`
          : `Installed Workhorse schema v${version}. Runtime expects v${WORKHORSE_SCHEMA_VERSION}.\n`,
      );
      // Status is also where an operator finds out that the server itself is outside the tested
      // matrix, which no schema version can express.
      const support = await readPostgresSupport(pool);
      process.stdout.write(
        `PostgreSQL ${support.version}: ${
          !support.supported
            ? `unsupported, below the required major ${MINIMUM_POSTGRES_MAJOR}`
            : support.tested
              ? "supported and covered by CI"
              : "supported, but this major is not covered by CI"
        }.\n`,
      );
      if (version !== null && version !== WORKHORSE_SCHEMA_VERSION) process.exitCode = 1;
      if (!support.supported) process.exitCode = 1;
      return;
    }
    // Installation is clean-database only by design. It refuses to touch an existing schema rather
    // than pretending to be a migration, which this pre-release line deliberately does not have.
    await installSchema(pool);
    process.stdout.write(`Installed Workhorse schema v${WORKHORSE_SCHEMA_VERSION}.\n`);
  } finally {
    await pool.end();
  }
}

async function runDashboardCommand(args: readonly string[]): Promise<void> {
  const databaseUrl = resolveDatabaseUrl(args);
  const portValue = valueAfter(args, "--port");
  const port = portValue === undefined ? 3000 : parsePositiveInteger(portValue, "--port");
  const hostname = valueAfter(args, "--host") ?? "127.0.0.1";
  const allowMutations = args.includes("--allow-mutations");
  const actor = valueAfter(args, "--actor") ?? "workhorse-cli";

  // The console has no session, header, or identity provider to consult. Anything that widens its
  // reach past a read-only loopback listener is the operator's explicit decision, said out loud.
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    process.stderr.write(
      `Warning: binding ${hostname} exposes an unauthenticated dashboard. Put it behind your own authenticated proxy.\n`,
    );
  }
  if (allowMutations) {
    process.stderr.write(
      `Warning: mutations are enabled and attributed to "${actor}". Attribution is not authorization.\n`,
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const running = await startDashboardServer(pool, {
    port,
    hostname,
    allowMutations,
    actor,
  });
  process.stdout.write(
    `Workhorse dashboard on ${running.url} (${allowMutations ? "mutations enabled" : "read-only"})\n`,
  );

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void running.close().then(() => pool.end());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runInitCommand(args: readonly string[]): Promise<void> {
  const directory = path.resolve(process.cwd(), valueAfter(args, "--dir") ?? ".");
  const result = await initializeProject(directory, { force: args.includes("--force") });
  process.stdout.write(
    result.written
      ? `Wrote ${path.relative(process.cwd(), result.configPath) || result.configPath}\n`
      : `${path.relative(process.cwd(), result.configPath) || result.configPath} already exists; pass --force to overwrite.\n`,
  );
  process.stdout.write(
    `Detected ${result.project.orm} + ${result.project.framework} (${result.project.packageManager}).\n\nNext steps:\n`,
  );
  for (const step of result.nextSteps) process.stdout.write(`${step}\n`);
}

async function main(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (args[1] === "--help" || args[1] === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  if (command === "dashboard") {
    await runDashboardCommand(args.slice(1));
    return;
  }
  if (command === "init") {
    await runInitCommand(args.slice(1));
    return;
  }
  if (command === "schema") {
    await runSchemaCommand(args.slice(1));
    return;
  }
  if (command !== "worker") throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  const options = parseWorkerOptions(args.slice(1));
  const definition = await loadDefinition(options.config);
  await runWorkerProcess(definition, { shutdownTimeoutMs: options.shutdownTimeoutMs });
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
}
