#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DashboardSingleAdminOptions } from "@stablemates/workhorse-dashboard-contract";
import { Pool } from "pg";
import {
  installSchema,
  isMissingDatabaseRelationError,
  migrateSchema,
  readProtocolVersions,
  readSchemaVersion,
  WORKHORSE_SCHEMA_VERSION,
} from "../schema.js";
import { MINIMUM_POSTGRES_MAJOR, readPostgresSupport } from "../support.js";
import { runWorkerProcess } from "../worker-process.js";
import type { WorkerProcessDefinition } from "../worker-process.js";
import {
  CliUsageError,
  databaseOptionDefinitions,
  parseCommandArgs,
  resolveDatabaseUrl,
  USAGE_EXIT_CODE,
} from "./arguments.js";
import { startDashboardServer } from "./dashboard.js";
import { runHealthCommand } from "./health.js";
import { initializeProject } from "./init.js";
import { createSchemaStatusReport } from "./schema-status.js";

const ROOT_HELP = `Usage: workhorse <command> [options]

Commands:
  init       Detect a project and scaffold a worker configuration.
  schema     Install the schema or report schema and PostgreSQL compatibility.
  worker     Run workers from a compiled configuration module.
  dashboard  Serve the operator dashboard against a Workhorse database.
  admin      Inspect jobs, queues, schedules, failures, workers, checkpoints, waits, and
             maintenance state, and run guarded cancel, redrive, pause, resume, purge, and
             worker-pause operations.
  tui        Interactive terminal views over the same administrative client.
  health     Report queue health.

Global options:
  --help, -h  Show this help.
  --version   Show the @stablemates/workhorse version.

Exit codes:
  0   Success.
  1   Runtime failure, and a schema or PostgreSQL "schema status" reports as unusable.
  2   Queue degradation reported by health.
  64  Usage error, including an unknown command, flag, or missing value.
`;

const INIT_HELP = `Usage: workhorse init [options]

Options:
  --dir <path>  Project directory (default: current directory).
  --force       Overwrite an existing generated configuration.
  --help, -h    Show this help.
`;

const SCHEMA_HELP = `Usage:
  workhorse schema install [options]
  workhorse schema migrate [options]
  workhorse schema status [options]

Commands:
  install  Install the Workhorse schema into a clean database.
  migrate  Apply the ordered forward-only migrations to an installed schema.
  status   Report the installed schema version and PostgreSQL support separately.

Use "workhorse schema <command> --help" for command options.
`;

const DATABASE_HELP = `  --database-url <url>  Database URL. This takes precedence over all other sources.

The fallback order is WORKHORSE_DATABASE_URL, then DATABASE_URL.
`;

const SCHEMA_INSTALL_HELP = `Usage: workhorse schema install [options]

Options:
${DATABASE_HELP}  --help, -h              Show this help.
`;

const SCHEMA_MIGRATE_HELP = `Usage: workhorse schema migrate [options]

Options:
${DATABASE_HELP}  --help, -h              Show this help.

Run this from a deployment step before processes from the new release start. Each migration commits
one version step in its own transaction behind the workhorse:schema-migration advisory lock. An
already-current schema is left unchanged.
`;

const SCHEMA_STATUS_HELP = `Usage: workhorse schema status [options]

Options:
${DATABASE_HELP}  --json                  Emit a machine-readable status object.
  --help, -h              Show this help.

The default output is human-readable. Schema acceptance and PostgreSQL support are separate fields
in JSON output. This command exits 1 when this runtime would refuse the installed schema, or when
the server is below the required major. Read the JSON fields to tell the two apart.

Run this after "schema migrate" and before starting the application. A schema ahead of this build
is accepted: inside a major line a migration only adds, so "schema.state" reporting "ahead" is the
normal middle of a rolling upgrade. The field a deployment gate reads is "schema.compatible".
`;

const WORKER_HELP = `Usage: workhorse worker --config <compiled-module> [options]

Options:
  --config <module>                 Compiled worker configuration module (required).
  --shutdown-timeout-ms <number>    Graceful shutdown deadline in milliseconds.
  --help, -h                        Show this help.

The worker configuration must be JavaScript that the current Node.js process can import. Compile
TypeScript configuration files before invoking the packaged CLI.
`;

const DASHBOARD_HELP = `Usage: workhorse dashboard [options]

Options:
${DATABASE_HELP}  --port <port>            TCP port (default: 3000).
  --host <interface>       TCP interface (default: 127.0.0.1).
  --socket <path>          Listen on a Unix socket instead of TCP.
  --public-origin <origin> Public HTTPS origin for a remote authenticated listener.
  --allow-mutations        Enable dashboard mutations.
  --actor <name>           Actor recorded for mutations (default: workhorse-cli).
  --workspace <name=url>   Serve <url> as workspace <name>. Repeatable.
  --config <file>          JSON workspace configuration file.
  --help, -h               Show this help.

The dashboard binds 127.0.0.1 and is read-only unless told otherwise. Set
WORKHORSE_DASHBOARD_USERNAME and WORKHORSE_DASHBOARD_PASSWORD_HASH, or their _FILE variants, to
enable single-administrator sessions. Unauthenticated listeners are limited to loopback or a Unix
socket. A remote authenticated listener requires WORKHORSE_DASHBOARD_PUBLIC_ORIGIN with HTTPS.

Workspaces serve several databases from one dashboard, switchable in the browser. The
configuration file holds {"workspaces": {"<name>": {"url": "..."}}, "defaultWorkspace": "<name>"};
an entry may state {"urlEnv": "SOME_VARIABLE"} instead of "url" to keep credentials out of the
file. --workspace entries override same-named file entries. Workspaces cannot be combined with
--database-url, and the database URL environment fallbacks are ignored while workspaces are
configured.
`;

const TUI_HELP = `Usage: workhorse tui [options]

Options:
${DATABASE_HELP}  --env <database>        Enable pause and resume; must equal the connected database's name.
  --help, -h              Show this help.

Views: jobs, queues, schedules, failures, workers, and health. Keys 1 through 6 switch views,
r refreshes, and q quits. Without --env the session is read-only; with it, the queues view can
pause and resume the selected queue after an in-place confirmation. The same administrative
client and environment check back "workhorse admin".
`;

const HEALTH_HELP = `Usage: workhorse health [options]

Options:
${DATABASE_HELP}  --json                  Emit the full machine-readable QueueHealth object.
  --help, -h              Show this help.

The default output is human-readable. Exit 2 means queue degradation; malformed usage exits 64.
`;

interface WorkerCommandOptions {
  config: string;
  shutdownTimeoutMs?: number;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`${flag} must be a positive safe integer`);
  }
  return parsed;
}

function parseWorkerOptions(args: readonly string[]): WorkerCommandOptions | null {
  const { values } = parseCommandArgs("worker", {
    args,
    options: {
      config: { type: "string" },
      "shutdown-timeout-ms": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return null;
  if (!values.config) throw new CliUsageError("worker requires --config <compiled-module>");
  return {
    config: values.config,
    shutdownTimeoutMs:
      values["shutdown-timeout-ms"] === undefined
        ? undefined
        : parsePositiveInteger(values["shutdown-timeout-ms"], "--shutdown-timeout-ms"),
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

async function dashboardSecret(name: string): Promise<string | undefined> {
  const direct = process.env[name];
  const file = process.env[`${name}_FILE`];
  if (direct !== undefined && file !== undefined) {
    throw new Error(`Set either ${name} or ${name}_FILE, not both`);
  }
  if (direct !== undefined) return direct;
  if (file === undefined) return undefined;
  const value = await readFile(file, "utf8");
  return value.replace(/\r?\n$/, "");
}

async function resolveDashboardAuthentication(): Promise<DashboardSingleAdminOptions | undefined> {
  const username = await dashboardSecret("WORKHORSE_DASHBOARD_USERNAME");
  const passwordHash = await dashboardSecret("WORKHORSE_DASHBOARD_PASSWORD_HASH");
  const previousPasswordHash = await dashboardSecret("WORKHORSE_DASHBOARD_PREVIOUS_PASSWORD_HASH");
  const previousPasswordHashExpiresAt = await dashboardSecret(
    "WORKHORSE_DASHBOARD_PREVIOUS_PASSWORD_HASH_EXPIRES_AT",
  );
  if (
    username === undefined &&
    passwordHash === undefined &&
    previousPasswordHash === undefined &&
    previousPasswordHashExpiresAt === undefined
  ) {
    return undefined;
  }
  if (username === undefined || passwordHash === undefined) {
    throw new Error(
      "Dashboard authentication requires both WORKHORSE_DASHBOARD_USERNAME and WORKHORSE_DASHBOARD_PASSWORD_HASH",
    );
  }
  if (Boolean(previousPasswordHash) !== Boolean(previousPasswordHashExpiresAt)) {
    throw new Error(
      "Dashboard credential rotation requires both WORKHORSE_DASHBOARD_PREVIOUS_PASSWORD_HASH and WORKHORSE_DASHBOARD_PREVIOUS_PASSWORD_HASH_EXPIRES_AT",
    );
  }
  return {
    username,
    passwordHash,
    previousPasswordHash,
    previousPasswordHashExpiresAt,
  };
}

async function runSchemaCommand(args: readonly string[]): Promise<void> {
  const action = args[0];
  if (!action || action === "--help" || action === "-h") {
    const { values } = parseCommandArgs("schema", {
      args,
      options: { help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: false,
    });
    if (values.help || args.length === 0) {
      process.stdout.write(SCHEMA_HELP);
      return;
    }
  }
  if (action !== "install" && action !== "migrate" && action !== "status") {
    throw new CliUsageError(`Unknown schema command: ${String(action)}`);
  }
  const { values } = parseCommandArgs(`schema ${action}`, {
    args: args.slice(1),
    options: {
      ...databaseOptionDefinitions,
      ...(action === "status" ? { json: { type: "boolean" as const } } : {}),
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(
      action === "install"
        ? SCHEMA_INSTALL_HELP
        : action === "migrate"
          ? SCHEMA_MIGRATE_HELP
          : SCHEMA_STATUS_HELP,
    );
    return;
  }
  const databaseUrl = resolveDatabaseUrl(values);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    if (action === "status") {
      // A database with no Workhorse schema is a normal answer to "status", not a failure, so the
      // missing-relation and missing-schema codes are reported rather than thrown.
      const version = await readSchemaVersion(pool).catch((error: unknown) => {
        if (isMissingDatabaseRelationError(error)) return null;
        throw error;
      });
      // Status is also where an operator finds out that the server itself is outside the tested
      // matrix, which no schema version can express.
      const support = await readPostgresSupport(pool);
      const protocolVersions = version === null ? null : await readProtocolVersions(pool);
      const report = createSchemaStatusReport(version, protocolVersions, support);
      if (values.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(
          version === null
            ? `No Workhorse schema is installed. Runtime expects v${WORKHORSE_SCHEMA_VERSION}.\n`
            : `Installed Workhorse schema v${version}. Runtime expects v${WORKHORSE_SCHEMA_VERSION}.\n`,
        );
        if (protocolVersions !== null && protocolVersions.length > 0) {
          process.stdout.write(
            `Installed SQL protocol versions: ${protocolVersions.map((value) => `v${value}`).join(", ")}.\n`,
          );
        }
        process.stdout.write(
          report.schema.refusal === null
            ? "This runtime accepts the installed schema.\n"
            : `${report.schema.refusal}\n`,
        );
        process.stdout.write(
          `PostgreSQL ${support.version}: ${
            !support.supported
              ? `unsupported, below the required major ${MINIMUM_POSTGRES_MAJOR}`
              : support.tested
                ? "supported and covered by CI"
                : "supported, but this major is not covered by CI"
          }.\n`,
        );
      }
      // The gate is acceptance, not equality. A schema ahead of this build is the normal middle of
      // a rolling upgrade, and failing a deploy on it would defeat the additive rule that allows it.
      if (!report.schema.compatible || !support.supported) process.exitCode = 1;
      return;
    }
    if (action === "migrate") {
      const before = await readSchemaVersion(pool).catch(() => null);
      await migrateSchema(pool);
      process.stdout.write(
        before === WORKHORSE_SCHEMA_VERSION
          ? `Workhorse schema v${WORKHORSE_SCHEMA_VERSION} is already current.\n`
          : `Migrated Workhorse schema v${String(before)} to v${WORKHORSE_SCHEMA_VERSION}.\n`,
      );
      return;
    }
    // Installation is clean-database only by design. It refuses to touch an existing schema rather
    // than pretending to be a migration; migrateSchema owns upgrades.
    await installSchema(pool);
    process.stdout.write(`Installed Workhorse schema v${WORKHORSE_SCHEMA_VERSION}.\n`);
  } finally {
    await pool.end();
  }
}

interface DashboardWorkspaceUrls {
  workspaces: Record<string, string>;
  defaultWorkspace?: string;
}

function parseWorkspaceFlag(entries: readonly string[]): Record<string, string> {
  const workspaces: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1 || separator === entry.length - 1) {
      throw new CliUsageError(`--workspace requires <name>=<database-url>, got: ${entry}`);
    }
    workspaces[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return workspaces;
}

async function readWorkspaceConfigFile(file: string): Promise<DashboardWorkspaceUrls> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new CliUsageError(
      `Cannot read --config ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError(`--config ${file} must contain a JSON object`);
  }
  const { workspaces, defaultWorkspace } = parsed as {
    workspaces?: unknown;
    defaultWorkspace?: unknown;
  };
  if (typeof workspaces !== "object" || workspaces === null || Array.isArray(workspaces)) {
    throw new CliUsageError(`--config ${file} must declare a "workspaces" object`);
  }
  if (defaultWorkspace !== undefined && typeof defaultWorkspace !== "string") {
    throw new CliUsageError(`--config ${file}: "defaultWorkspace" must be a workspace name`);
  }
  const urls: Record<string, string> = {};
  for (const [name, entry] of Object.entries(workspaces)) {
    const workspace = entry as { url?: unknown; urlEnv?: unknown };
    const inline = typeof workspace?.url === "string" ? workspace.url : undefined;
    const variable = typeof workspace?.urlEnv === "string" ? workspace.urlEnv : undefined;
    if (Boolean(inline) === Boolean(variable)) {
      throw new CliUsageError(
        `--config ${file}: workspace "${name}" must state exactly one of "url" or "urlEnv"`,
      );
    }
    const url = inline ?? process.env[variable as string];
    if (!url) {
      throw new CliUsageError(
        `--config ${file}: workspace "${name}" names the unset variable ${variable}`,
      );
    }
    urls[name] = url;
  }
  return { workspaces: urls, defaultWorkspace };
}

async function runDashboardCommand(args: readonly string[]): Promise<void> {
  const { values } = parseCommandArgs("dashboard", {
    args,
    options: {
      ...databaseOptionDefinitions,
      port: { type: "string" },
      host: { type: "string" },
      socket: { type: "string" },
      "public-origin": { type: "string" },
      "allow-mutations": { type: "boolean" },
      actor: { type: "string" },
      workspace: { type: "string", multiple: true },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(DASHBOARD_HELP);
    return;
  }
  const fromFile = values.config ? await readWorkspaceConfigFile(values.config) : undefined;
  const fromFlags = parseWorkspaceFlag(values.workspace ?? []);
  const workspaceUrls: DashboardWorkspaceUrls | undefined =
    fromFile || Object.keys(fromFlags).length > 0
      ? {
          workspaces: { ...fromFile?.workspaces, ...fromFlags },
          defaultWorkspace: fromFile?.defaultWorkspace,
        }
      : undefined;
  if (workspaceUrls && values["database-url"] !== undefined) {
    throw new CliUsageError("--database-url cannot be combined with workspaces");
  }
  const databaseUrl = workspaceUrls ? undefined : resolveDatabaseUrl(values);
  const port = values.port === undefined ? 3000 : parsePositiveInteger(values.port, "--port");
  const hostname = values.host ?? "127.0.0.1";
  const socketPath = values.socket;
  if (socketPath && (values.host !== undefined || values.port !== undefined)) {
    throw new CliUsageError("--socket cannot be combined with --host or --port");
  }
  const publicOrigin = values["public-origin"] ?? process.env.WORKHORSE_DASHBOARD_PUBLIC_ORIGIN;
  const allowMutations = values["allow-mutations"] ?? false;
  const actor = values.actor ?? "workhorse-cli";
  const authentication = await resolveDashboardAuthentication();

  if (allowMutations) {
    process.stderr.write(
      `Warning: mutations are enabled and attributed to "${actor}". Attribution is not authorization.\n`,
    );
  }

  const pools: Pool[] = [];
  const connect = (url: string): Pool => {
    const pool = new Pool({ connectionString: url });
    pools.push(pool);
    return pool;
  };
  const target = workspaceUrls
    ? {
        workspaces: Object.fromEntries(
          Object.entries(workspaceUrls.workspaces).map(([name, url]) => [name, connect(url)]),
        ),
        defaultWorkspace: workspaceUrls.defaultWorkspace,
      }
    : connect(databaseUrl as string);
  const running = await startDashboardServer(target, {
    port,
    hostname,
    socketPath,
    publicOrigin,
    allowMutations,
    actor,
    authentication,
  });
  process.stdout.write(
    `Workhorse dashboard on ${running.url} (${allowMutations ? "mutations enabled" : "read-only"})\n`,
  );

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void running.close().then(() => Promise.all(pools.map((pool) => pool.end())));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runInitCommand(args: readonly string[]): Promise<void> {
  const { values } = parseCommandArgs("init", {
    args,
    options: {
      dir: { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(INIT_HELP);
    return;
  }
  const directory = path.resolve(process.cwd(), values.dir ?? ".");
  const result = await initializeProject(directory, { force: values.force ?? false });
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

async function runTui(args: readonly string[]): Promise<void> {
  const { values } = parseCommandArgs("tui", {
    args,
    options: {
      ...databaseOptionDefinitions,
      env: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(TUI_HELP);
    return;
  }
  const { runTuiCommand } = await import("./tui.js");
  await runTuiCommand({ databaseUrl: resolveDatabaseUrl(values), environment: values.env });
}

async function runHealth(args: readonly string[]): Promise<void> {
  const { values } = parseCommandArgs("health", {
    args,
    options: {
      ...databaseOptionDefinitions,
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(HEALTH_HELP);
    return;
  }
  await runHealthCommand({ databaseUrl: resolveDatabaseUrl(values), json: values.json ?? false });
}

async function packageVersion(): Promise<string> {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const packagePath = path.join(directory, "package.json");
    try {
      const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === "@stablemates/workhorse" && typeof manifest.version === "string") {
        return manifest.version;
      }
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      if (code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error("Could not locate @stablemates/workhorse package.json");
    directory = parent;
  }
}

async function main(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (!command) {
    process.stdout.write(ROOT_HELP);
    return;
  }
  if (command === "help") {
    if (args.length !== 1) throw new CliUsageError(`Unexpected workhorse argument: ${args[1]}`);
    process.stdout.write(ROOT_HELP);
    return;
  }
  if (command === "--help" || command === "-h") {
    parseCommandArgs("workhorse", {
      args,
      options: { help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: false,
    });
    process.stdout.write(ROOT_HELP);
    return;
  }
  if (command === "--version") {
    parseCommandArgs("workhorse", {
      args,
      options: { version: { type: "boolean" } },
      strict: true,
      allowPositionals: false,
    });
    process.stdout.write(`${await packageVersion()}\n`);
    return;
  }
  if (command.startsWith("-")) {
    parseCommandArgs("workhorse", {
      args,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    });
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
  if (command === "admin") {
    const { runAdminCommand } = await import("./admin.js");
    await runAdminCommand(args.slice(1));
    return;
  }
  if (command === "tui") {
    await runTui(args.slice(1));
    return;
  }
  if (command === "health") {
    await runHealth(args.slice(1));
    return;
  }
  if (command !== "worker") throw new CliUsageError(`Unknown command: ${command}`);
  const options = parseWorkerOptions(args.slice(1));
  if (!options) {
    process.stdout.write(WORKER_HELP);
    return;
  }
  const definition = await loadDefinition(options.config);
  await runWorkerProcess(definition, { shutdownTimeoutMs: options.shutdownTimeoutMs });
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof CliUsageError) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = USAGE_EXIT_CODE;
  } else if (error instanceof Error && error.name === "AdminSafetyError") {
    process.stderr.write(`Refused: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  }
}
