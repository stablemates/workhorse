/**
 * The PgBouncer fixture the pooling conformance lanes run against.
 *
 * `up` starts one container per `pool_mode` against this checkout's test PostgreSQL and prints
 * the two environment variables the lanes read. `down` removes the containers. `test` does the
 * whole round trip: up, `integration-pooling.test.ts` with the lane variables set, then down.
 *
 * The fixture needs no schema of its own: each lane rewrites the URL's database name to its
 * isolated test database, which the wildcard `[databases]` entry forwards.
 *
 * Usage: pnpm pooling:up | pnpm pooling:down | pnpm test:pooling
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { localDatabaseUrl } from "../typescript/core/src/local-database.js";

const IMAGE = "pgbouncer/pgbouncer:1.25.2";

interface FixtureLane {
  readonly mode: "session" | "transaction";
  readonly container: string;
  readonly port: number;
  readonly envVar: string;
}

const lanes: readonly FixtureLane[] = [
  {
    mode: "session",
    container: "workhorse-pooling-session",
    port: 6432,
    envVar: "WORKHORSE_TEST_SESSION_POOL_URL",
  },
  {
    mode: "transaction",
    container: "workhorse-pooling-transaction",
    port: 6433,
    envVar: "WORKHORSE_TEST_TRANSACTION_POOL_URL",
  },
];

const checkoutRoot = fileURLToPath(new URL("..", import.meta.url));

function docker(...arguments_: string[]): void {
  const result = spawnSync("docker", arguments_, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`docker ${arguments_[0]} failed with exit code ${String(result.status)}`);
  }
}

function laneClientUrl(source: URL, lane: FixtureLane): string {
  const url = new URL(source.toString());
  url.hostname = "127.0.0.1";
  url.port = String(lane.port);
  return url.toString();
}

function startLane(source: URL, lane: FixtureLane): void {
  const localhost = source.hostname === "localhost" || source.hostname === "127.0.0.1";
  spawnSync("docker", ["rm", "-f", lane.container], { stdio: "ignore" });
  docker(
    "run",
    "-d",
    "--name",
    lane.container,
    "--add-host=host.docker.internal:host-gateway",
    "-p",
    `127.0.0.1:${String(lane.port)}:${String(lane.port)}`,
    "-e",
    `DATABASES_HOST=${localhost ? "host.docker.internal" : source.hostname}`,
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
    IMAGE,
  );
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

const [command] = process.argv.slice(2);
const source = new URL(localDatabaseUrl("test"));

switch (command) {
  case "up": {
    for (const lane of lanes) startLane(source, lane);
    for (const lane of lanes) await waitForLane(laneClientUrl(source, lane));
    for (const lane of lanes) {
      console.log(`${lane.envVar}=${laneClientUrl(source, lane)}`);
    }
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
    const environment = { ...process.env };
    try {
      for (const lane of lanes) startLane(source, lane);
      for (const lane of lanes) {
        await waitForLane(laneClientUrl(source, lane));
        environment[lane.envVar] = laneClientUrl(source, lane);
      }
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
      for (const lane of lanes) {
        spawnSync("docker", ["rm", "-f", lane.container], { stdio: "ignore" });
      }
    }
    break;
  }
  default:
    console.error("Usage: tsx scripts/pooling-fixture.ts up|down|test");
    process.exit(2);
}
