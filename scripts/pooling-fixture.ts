/**
 * The pooler fixture the pooling conformance lanes run against.
 *
 * `up` starts one container per pooler and `pool_mode` against this checkout's test PostgreSQL
 * and emits the environment variables the lanes read. `down` removes the containers. `test` does
 * the whole round trip: up, `integration-pooling.test.ts` with the lane variables set, then down.
 * When `GITHUB_ENV` is set (a CI step), the lane variables are appended to it instead of printed.
 *
 * PgBouncer needs no configuration: its wildcard `[databases]` entry forwards whatever database
 * name the test writes into the URL. PgCat routes on pool names fixed in `pgcat.toml`, so this
 * script generates a config naming the fixture's deterministic pooling and scratch databases and
 * creates both databases before the container starts.
 *
 * Usage: pnpm pooling:up | pnpm pooling:down | pnpm test:pooling
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  databaseName,
  localDatabaseUrl,
  namedTestDatabaseUrl,
  poolingScratchName,
} from "../typescript/core/src/local-database.js";

const PGBOUNCER_IMAGE = "pgbouncer/pgbouncer:1.25.2";
const PGCAT_IMAGE = "ghcr.io/postgresml/pgcat:v1.2.0";

interface FixtureLane {
  readonly pooler: "pgbouncer" | "pgcat";
  readonly mode: "session" | "transaction";
  readonly container: string;
  readonly port: number;
  readonly envVar: string;
}

const lanes: readonly FixtureLane[] = [
  {
    pooler: "pgbouncer",
    mode: "session",
    container: "workhorse-pooling-session",
    port: 6432,
    envVar: "WORKHORSE_TEST_SESSION_POOL_URL",
  },
  {
    pooler: "pgbouncer",
    mode: "transaction",
    container: "workhorse-pooling-transaction",
    port: 6433,
    envVar: "WORKHORSE_TEST_TRANSACTION_POOL_URL",
  },
  {
    pooler: "pgcat",
    mode: "session",
    container: "workhorse-pooling-pgcat-session",
    port: 6434,
    envVar: "WORKHORSE_TEST_PGCAT_SESSION_POOL_URL",
  },
  {
    pooler: "pgcat",
    mode: "transaction",
    container: "workhorse-pooling-pgcat-transaction",
    port: 6435,
    envVar: "WORKHORSE_TEST_PGCAT_TRANSACTION_POOL_URL",
  },
];

const checkoutRoot = fileURLToPath(new URL("..", import.meta.url));

function docker(...arguments_: string[]): void {
  const result = spawnSync("docker", arguments_, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`docker ${arguments_[0]} failed with exit code ${String(result.status)}`);
  }
}

/** The client URL a lane sees: pooler port, pooling database name, test credentials. */
function laneClientUrl(source: URL, lane: FixtureLane, name: string): string {
  const url = new URL(source.toString());
  url.hostname = "127.0.0.1";
  url.port = String(lane.port);
  url.pathname = `/${name}`;
  return url.toString();
}

/** The host the containers use to reach this checkout's PostgreSQL. */
function serverHost(source: URL): string {
  const localhost = source.hostname === "localhost" || source.hostname === "127.0.0.1";
  return localhost ? "host.docker.internal" : source.hostname;
}

/** Create the named databases the poolers must see before the test provisions them itself. */
async function ensureDatabases(source: URL, names: readonly string[]): Promise<void> {
  const admin = new URL(source.toString());
  admin.pathname = "/postgres";
  const pool = new Pool({ connectionString: admin.toString(), max: 1 });
  try {
    for (const name of names) {
      const exists = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (exists.rowCount === 0) {
        await pool.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
      }
    }
  } finally {
    await pool.end();
  }
}

function startPgBouncer(source: URL, lane: FixtureLane): void {
  docker(
    "run",
    "-d",
    "--name",
    lane.container,
    "--add-host=host.docker.internal:host-gateway",
    "-p",
    `127.0.0.1:${String(lane.port)}:${String(lane.port)}`,
    "-e",
    `DATABASES_HOST=${serverHost(source)}`,
    "-e",
    `DATABASES_PORT=${source.port || "5432"}`,
    "-e",
    `DATABASES_USER=${decodeURIComponent(source.username)}`,
    "-e",
    `DATABASES_PASSWORD=${decodeURIComponent(source.password)}`,
    "-e",
    `PGBOUNCER_POOL_MODE=${lane.mode}`,
    "-e",
    `PGBOUNCER_LISTEN_PORT=${String(lane.port)}`,
    PGBOUNCER_IMAGE,
  );
}

/** One PgCat pool stanza per database name; the pool name equals the database it routes to. */
function pgcatPool(name: string, lane: FixtureLane, source: URL): string {
  return `
[pools.${name}]
pool_mode = "${lane.mode}"

[pools.${name}.users.0]
username = "${decodeURIComponent(source.username)}"
password = "${decodeURIComponent(source.password)}"
pool_size = 10

[pools.${name}.shards.0]
database = "${name}"
servers = [["${serverHost(source)}", ${source.port || "5432"}, "primary"]]
`;
}

function startPgCat(source: URL, lane: FixtureLane, names: readonly string[]): void {
  const directory = mkdtempSync(join(tmpdir(), "workhorse-pgcat-"));
  const config = join(directory, "pgcat.toml");
  writeFileSync(
    config,
    `[general]
host = "0.0.0.0"
port = ${String(lane.port)}
admin_username = "admin"
admin_password = "admin"
admin_stats_enabled = false
${names.map((name) => pgcatPool(name, lane, source)).join("")}`,
  );
  docker(
    "run",
    "-d",
    "--name",
    lane.container,
    "--add-host=host.docker.internal:host-gateway",
    "-p",
    `127.0.0.1:${String(lane.port)}:${String(lane.port)}`,
    "-v",
    `${config}:/etc/pgcat/pgcat.toml`,
    PGCAT_IMAGE,
  );
}

function startLane(source: URL, lane: FixtureLane, names: readonly string[]): void {
  spawnSync("docker", ["rm", "-f", lane.container], { stdio: "ignore" });
  if (lane.pooler === "pgcat") startPgCat(source, lane, names);
  else startPgBouncer(source, lane);
}

async function waitForLane(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    let failure: unknown;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await pool.query("SELECT 1");
        return;
      } catch (error) {
        failure = error;
        await sleep(100);
      }
    }
    throw failure;
  } finally {
    await pool.end();
  }
}

/** Give the caller the lane variables, through GitHub's step environment when running in CI. */
function emitLaneUrls(environment: Record<string, string>): void {
  const lines = lanes.map((lane) => `${lane.envVar}=${environment[lane.envVar]}`);
  if (process.env.GITHUB_ENV !== undefined) {
    appendFileSync(process.env.GITHUB_ENV, `${lines.join("\n")}\n`);
    return;
  }
  for (const line of lines) console.log(line);
}

async function bringUp(source: URL): Promise<Record<string, string>> {
  const poolingName = databaseName(namedTestDatabaseUrl(source.toString(), "pooling"));
  const scratchName = poolingScratchName(poolingName);
  const names = [poolingName, scratchName];
  await ensureDatabases(source, names);
  for (const lane of lanes) startLane(source, lane, names);
  const environment: Record<string, string> = {};
  for (const lane of lanes) {
    const url = laneClientUrl(source, lane, poolingName);
    await waitForLane(url);
    environment[lane.envVar] = url;
  }
  return environment;
}

function bringDown(): void {
  for (const lane of lanes) {
    spawnSync("docker", ["rm", "-f", lane.container], { stdio: "ignore" });
  }
}

const [command] = process.argv.slice(2);
const source = new URL(localDatabaseUrl("test"));

switch (command) {
  case "up": {
    const environment = await bringUp(source);
    emitLaneUrls(environment);
    console.log("Pooling fixture is up. Export the variables above or use pnpm test:pooling.");
    break;
  }
  case "down": {
    for (const lane of lanes) {
      spawnSync("docker", ["rm", "-f", lane.container], { stdio: "inherit" });
    }
    break;
  }
  case "test": {
    try {
      const environment = { ...process.env, ...(await bringUp(source)) };
      const vitest = spawn(
        process.execPath,
        [
          join(checkoutRoot, "node_modules/vitest/vitest.mjs"),
          "run",
          "typescript/core/test/integration-pooling.test.ts",
        ],
        { cwd: checkoutRoot, env: environment, stdio: "inherit" },
      );
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        vitest.once("error", reject);
        vitest.once("exit", resolve);
      });
      process.exitCode = exitCode ?? 1;
    } finally {
      bringDown();
    }
    break;
  }
  default:
    console.error("Usage: tsx scripts/pooling-fixture.ts up|down|test");
    process.exit(2);
}
