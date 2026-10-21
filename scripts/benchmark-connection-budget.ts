#!/usr/bin/env node
/**
 * Measures the connections that the workers of each SDK hold on one shared pool, and how old their
 * lease renewals become (SM-1566). The driver measures from PostgreSQL, so one script serves every
 * SDK. Nothing in CI runs this benchmark.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, freemem, loadavg, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import {
  nearestRankPercentile,
  summarizeLatencies,
} from "../typescript/core/benchmarks/statistics.js";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseUrl,
} from "../typescript/core/src/local-database.js";
import { Queue } from "../typescript/core/src/queue.js";
import { installSchema } from "../typescript/core/src/schema.js";
import {
  connectionRoles,
  emptyRoleSampling,
  mergeChunk,
  roleChunkMs,
  roleSampleIntervalMs,
  round,
  type RoleChunk,
  type RoleSampling,
} from "./connection-budget-roles.js";

const help = `Workhorse connection budget benchmark

Starts the probe of one SDK for each cell of a matrix. A probe runs W workers in one process on
one pool of P connections, with concurrency C, heartbeat interval I, and lease L. Every handler
sleeps until the probe stops. Every 250 ms the driver samples pg_stat_activity and
workhorse.task_runtime, and records the pool state that the probe reports. A role sampler in the
database reads pg_stat_activity about every 2 ms to find the listener and heartbeat connections.
The driver writes one JSON artifact. Cells run one at a time. Before each cell the driver
waits while the 1-minute load is above 16 or available memory is below 8 GB.

Usage:
  pnpm benchmark:connection-budget -- [options]

Options:
  --sdk LIST        SDK variants, comma-separated (default: all)
                    ${"typescript,go,ruby,python-sync,python-async,python-asyncpg,rust,jvm"}
  --profile NAME    smoke or full (default: smoke)
  --cells LIST      Only run the cells with these ids, comma-separated
  --out PATH        Write the JSON artifact to PATH
                    (default: benchmark-connection-budget-<profile>.json)
  --no-build        Use the probe builds that already exist
  --no-commit-inference
                    Count only heartbeat markers as rounds, not a COMMIT after a marker
  --help            Show this help`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const queueName = "benchmark-connection-budget";
const taskType = "benchmark.connection-budget.sleep";
const driverApplicationName = "wh-bench-driver";
const sampleIntervalMs = 250;
const stopGraceMs = 20_000;
/** A claim gap at least this long, with free slots and ready tasks, is a progress failure. */
const progressFailureMs = 10_000;
const guard = { maxLoad1m: 16, minAvailableBytes: 8 * 1024 ** 3, pollMs: 15_000 };

// --- Command line ----------------------------------------------------------------------------

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function list(name: string): string[] | undefined {
  return argument(name)
    ?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

// --- SDK variants ----------------------------------------------------------------------------

interface ProbeCommand {
  command: string;
  args: string[];
  cwd: string;
}

interface SdkVariant {
  /** Commands that build the probe before the first cell. Each runs once. */
  build: ProbeCommand[];
  /** The command that starts the probe for one cell. */
  probe: () => ProbeCommand;
  /** Commands whose output names the toolchain and driver versions. */
  versions: ProbeCommand[];
  /** The manifest that declares the SDK version, and the pattern whose first group reads it. */
  manifest: [path: string, pattern: RegExp];
}

function sdkVersion({ manifest: [path, pattern] }: SdkVariant): string | null {
  try {
    return pattern.exec(readFileSync(join(root, path), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

function mise(args: string[], cwd = root): ProbeCommand {
  return { command: "mise", args: ["exec", "--", ...args], cwd };
}

const pythonProbe = join(root, "python/tools/connection_budget_probe.py");
const goProbeBinary = join(root, "target/connection-budget/go-probe");
const jvmClasspathFile = join(
  root,
  "jvm/connection-budget-probe/build/connection-budget-classpath.txt",
);

function pythonVariant(variant: string): SdkVariant {
  return {
    build: [mise(["uv", "sync", "--project", "python", "--quiet"])],
    probe: () =>
      mise(["uv", "run", "--project", "python", "--no-sync", "python", pythonProbe, variant]),
    versions: [
      mise(["uv", "run", "--project", "python", "--no-sync", "python", "--version"]),
      mise([
        "uv",
        "run",
        "--project",
        "python",
        "--no-sync",
        "python",
        "-c",
        "import importlib.metadata as m; print(*(f'{n} {m.version(n)}' for n in ('stablemates-workhorse', 'psycopg', 'psycopg-pool', 'asyncpg')))",
      ]),
    ],
    manifest: ["python/pyproject.toml", /^version = "([^"]+)"/m],
  };
}

const sdkVariants: Record<string, SdkVariant> = {
  typescript: {
    build: [],
    probe: () =>
      mise([
        "node",
        "--conditions=workhorse-source",
        "--import",
        "tsx",
        join(root, "scripts/benchmark-connection-budget-probe.ts"),
      ]),
    versions: [mise(["node", "--version"])],
    manifest: ["typescript/core/package.json", /"version": "([^"]+)"/],
  },
  go: {
    build: [
      mise(
        ["go", "build", "-o", goProbeBinary, "."],
        join(root, "benchmarks/connection-budget/go-probe"),
      ),
    ],
    probe: () => ({ command: goProbeBinary, args: [], cwd: root }),
    versions: [mise(["go", "version"])],
    manifest: ["go/version.go", /const Version = "([^"]+)"/],
  },
  ruby: {
    build: [mise(["bundle", "install", "--quiet"], join(root, "ruby"))],
    probe: () =>
      mise(["bundle", "exec", "ruby", "tools/connection_budget_probe.rb"], join(root, "ruby")),
    versions: [mise(["ruby", "--version"])],
    manifest: ["ruby/lib/stablemates/workhorse/version.rb", /VERSION = "([^"]+)"/],
  },
  "python-sync": pythonVariant("sync"),
  "python-async": pythonVariant("async"),
  "python-asyncpg": pythonVariant("asyncpg"),
  rust: {
    build: [
      mise(["cargo", "build", "--release", "--quiet", "-p", "workhorse-connection-budget-probe"]),
    ],
    probe: () => ({
      command: join(root, "target/release/workhorse-connection-budget-probe"),
      args: [],
      cwd: root,
    }),
    versions: [mise(["rustc", "--version"])],
    manifest: ["rust/Cargo.toml", /^version = "([^"]+)"/m],
  },
  jvm: {
    build: [
      mise([
        "gradle",
        "--quiet",
        "-p",
        "jvm",
        ":connection-budget-probe:connectionBudgetClasspath",
      ]),
    ],
    probe: () =>
      mise([
        "java",
        "-cp",
        readFileSync(jvmClasspathFile, "utf8").trim(),
        "run.workhorse.probe.ConnectionBudgetProbe",
      ]),
    versions: [mise(["java", "--version"])],
    manifest: ["jvm/gradle.properties", /^version=(\S+)/m],
  },
};

// --- Matrix ----------------------------------------------------------------------------------

interface Cell {
  id: string;
  workers: number;
  concurrency: number;
  poolSize: number;
  heartbeatMs: number;
  leaseMs: number;
  /** Time from the probe start to the start of the measurement window. */
  warmupMs: number;
  /** Length of the measurement window. The cell ends when it closes. */
  measureMs: number;
}

function cell(
  id: string,
  shape: Pick<Cell, "workers" | "concurrency" | "poolSize" | "heartbeatMs" | "leaseMs">,
  warmupMs: number,
  measureMs: number,
): Cell {
  return { id, ...shape, warmupMs, measureMs };
}

const profiles: Record<"smoke" | "full", Cell[]> = {
  smoke: [
    cell(
      "smoke-w2-c2-p20",
      { workers: 2, concurrency: 2, poolSize: 20, heartbeatMs: 1_000, leaseMs: 3_000 },
      5_000,
      15_000,
    ),
  ],
  full: [
    cell(
      "starvation-w2-c1-p4",
      { workers: 2, concurrency: 1, poolSize: 4, heartbeatMs: 1_000, leaseMs: 3_000 },
      10_000,
      30_000,
    ),
    ...[1, 4, 16, 64].flatMap((workers) =>
      [1, 25].map((concurrency) =>
        cell(
          `capacity-w${workers}-c${concurrency}-p20`,
          { workers, concurrency, poolSize: 20, heartbeatMs: 1_000, leaseMs: 3_000 },
          15_000,
          60_000,
        ),
      ),
    ),
    ...[16, 64].map((workers) =>
      cell(
        `default-timing-w${workers}-c25-p20`,
        { workers, concurrency: 25, poolSize: 20, heartbeatMs: 10_000, leaseMs: 30_000 },
        20_000,
        180_000,
      ),
    ),
  ],
};

// --- Machine guard ---------------------------------------------------------------------------

/** `MemAvailable` from `/proc/meminfo`, which counts reclaimable cache; `os.freemem()` elsewhere. */
function availableMemoryBytes(): number {
  try {
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
    if (match) return Number(match[1]) * 1024;
  } catch {
    // Not Linux.
  }
  return freemem();
}

interface MachineState {
  at: string;
  loadAverage: number[];
  availableMemoryBytes: number;
}

function machineState(): MachineState {
  return {
    at: new Date().toISOString(),
    loadAverage: loadavg(),
    availableMemoryBytes: availableMemoryBytes(),
  };
}

function machineBusy(state: MachineState): boolean {
  return (
    state.loadAverage[0]! > guard.maxLoad1m || state.availableMemoryBytes < guard.minAvailableBytes
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Waits until the machine is below the guard limits, and records each busy poll. */
async function waitForQuietMachine(): Promise<{ waitedMs: number; busyPolls: MachineState[] }> {
  const started = Date.now();
  const busyPolls: MachineState[] = [];
  for (let state = machineState(); machineBusy(state); state = machineState()) {
    busyPolls.push(state);
    console.error(
      `machine busy: load ${state.loadAverage[0]!.toFixed(2)}, available ${(state.availableMemoryBytes / 1024 ** 3).toFixed(1)} GB; waiting ${guard.pollMs / 1000} s`,
    );
    await sleep(guard.pollMs);
  }
  return { waitedMs: Date.now() - started, busyPolls };
}

// --- Database --------------------------------------------------------------------------------

const databaseUrl = localDatabaseUrl("bench");
assertLocalDatabasePurpose(databaseUrl, "bench");

function withApplicationName(url: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

/**
 * The driver's own pools. Each one bounds connection acquisition and every statement, so a blocked
 * query cannot hold a cell past its deadline. `admin` installs the schema and enqueues; `sample`
 * reads every 250 ms; `final` reads the outcomes and ends leftover probe sessions.
 */
interface DriverPools {
  admin: Pool;
  sample: Pool;
  final: Pool;
}

function driverPool(max: number, statementTimeoutMs: number, connectTimeoutMs: number): Pool {
  return new Pool({
    connectionString: withApplicationName(databaseUrl, driverApplicationName),
    max,
    connectionTimeoutMillis: connectTimeoutMs,
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs + 500,
  });
}

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
  await installSchema(pool);
}

async function enqueueTasks(pool: Pool, count: number): Promise<void> {
  const queue = new Queue(pool, queueName);
  for (let offset = 0; offset < count; offset += 1_000) {
    const size = Math.min(1_000, count - offset);
    await queue.enqueueMany(
      Array.from({ length: size }, (_, index) => ({
        type: taskType,
        payload: { index: offset + index },
        // A lost lease retries the task. A high limit keeps a retried task in play.
        options: { maxAttempts: 100 },
      })),
    );
  }
}

/** One sample row. Each column is one value; `series` stores the rows in this column order. */
const sampleColumns = [
  "elapsedMs",
  "connectionsTotal",
  "connectionsActive",
  "connectionsIdle",
  "connectionsIdleInTransaction",
  "connectionsListen",
  "poolTotal",
  "poolIdle",
  "poolCheckedOut",
  "poolWaiting",
  "poolSampleAgeMs",
  "outOfPoolSessions",
  "activeTasks",
  "unexpiredActiveTasks",
  "expiredActiveTasks",
  "readyTasks",
  "claimEvents",
  "claimedTasks",
  "maxRenewalAgeMs",
  "minLeaseMarginMs",
] as const;

type SampleColumn = (typeof sampleColumns)[number];
type Sample = Record<SampleColumn, number | null> & { elapsedMs: number };

const connectionsSql = `
  SELECT count(*)::integer AS total,
         count(*) FILTER (WHERE state = 'active')::integer AS active,
         count(*) FILTER (WHERE state = 'idle')::integer AS idle,
         count(*) FILTER (WHERE state LIKE 'idle in transaction%')::integer AS idle_in_transaction,
         count(*) FILTER (WHERE query ~* '^\\s*LISTEN\\s')::integer AS listen
    FROM pg_stat_activity
   WHERE datname = current_database() AND application_name = $1`;

// `heartbeat_at` is the last accepted renewal. `expires_at` is the end of the current lease.
const leasesSql = `
  SELECT (extract(epoch FROM clock_timestamp() - heartbeat_at) * 1000)::double precision AS age_ms,
         (extract(epoch FROM expires_at - clock_timestamp()) * 1000)::double precision AS margin_ms
    FROM workhorse.task_runtime
   WHERE queue_name = $1 AND state = 'active'`;

// Each attempt writes one `claimed` event, so the count grows with every claim, also when a task
// that lost its lease is claimed again. The distinct tasks show how much of the queue was claimed.
const claimsSql = `
  SELECT count(*)::integer AS claim_events,
         count(DISTINCT e.task_id)::integer AS claimed_tasks,
         (SELECT count(*) FROM workhorse.task_runtime r
           WHERE r.queue_name = $1 AND r.state = 'ready')::integer AS ready
    FROM workhorse.task_event e
    JOIN workhorse.task t ON t.id = e.task_id
   WHERE t.queue_name = $1 AND e.event_type = 'claimed'`;

// The state and last statement of each probe connection, grouped. A heartbeat round ends with
// COMMIT, so the last statement names a LISTEN session but not a heartbeat connection.
const connectionSnapshotSql = `
  SELECT state, left(regexp_replace(query, '\\s+', ' ', 'g'), 80) AS last_query,
         count(*)::integer AS connections
    FROM pg_stat_activity
   WHERE datname = current_database() AND application_name = $1
   GROUP BY 1, 2
   ORDER BY 3 DESC, 1, 2`;

// Sessions of a probe: the one that runs now, or one that an earlier cell or run left behind.
const probeSessionsSql = `
  SELECT pid, application_name
    FROM pg_stat_activity
   WHERE datname = current_database() AND application_name LIKE 'wh-bench-%'
     AND application_name <> '${driverApplicationName}' AND pid <> pg_backend_pid()`;

interface ConnectionCounts {
  total: number;
  active: number;
  idle: number;
  idle_in_transaction: number;
  listen: number;
}

/** The pool state that a probe reports from inside its process, and when the driver read it. */
interface PoolSample {
  elapsedMs: number;
  total: number | null;
  idle: number | null;
  checkedOut: number | null;
  waiting: number | null;
  max: number | null;
  waitedAcquires: number | null;
}

interface CellSampling {
  samples: Sample[];
  measuredRenewalAgesMs: number[];
  measuredLeaseMarginsMs: number[];
  sampleErrors: number;
  sampleErrorMessages: string[];
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function takeSample(
  pool: Pool,
  applicationName: string,
  elapsedMs: number,
  poolSample: PoolSample | null,
): Promise<{ sample: Sample; ages: number[]; margins: number[] }> {
  const [connections, leases, claims] = await Promise.all([
    pool.query<ConnectionCounts>(connectionsSql, [applicationName]),
    pool.query<{ age_ms: number; margin_ms: number }>(leasesSql, [queueName]),
    pool.query<{ claim_events: number; claimed_tasks: number; ready: number }>(claimsSql, [
      queueName,
    ]),
  ]);
  const counts = connections.rows[0]!;
  const claimed = claims.rows[0]!;
  const ages = leases.rows.map((row) => row.age_ms);
  const margins = leases.rows.map((row) => row.margin_ms);
  const expired = margins.filter((margin) => margin <= 0).length;
  // A pool sample older than one second no longer describes the pool.
  const poolAgeMs = poolSample === null ? null : elapsedMs - poolSample.elapsedMs;
  const current = poolAgeMs !== null && poolAgeMs <= 1_000 ? poolSample : null;
  return {
    ages,
    margins,
    sample: {
      elapsedMs,
      connectionsTotal: counts.total,
      connectionsActive: counts.active,
      connectionsIdle: counts.idle,
      connectionsIdleInTransaction: counts.idle_in_transaction,
      connectionsListen: counts.listen,
      poolTotal: current?.total ?? null,
      poolIdle: current?.idle ?? null,
      poolCheckedOut: current?.checkedOut ?? null,
      poolWaiting: current?.waiting ?? null,
      poolSampleAgeMs: poolAgeMs,
      // Sessions that the pool does not count, such as the Rust listener connections.
      outOfPoolSessions:
        current?.total === null || current?.total === undefined
          ? null
          : counts.total - current.total,
      activeTasks: leases.rows.length,
      unexpiredActiveTasks: leases.rows.length - expired,
      expiredActiveTasks: expired,
      readyTasks: claimed.ready,
      claimEvents: claimed.claim_events,
      claimedTasks: claimed.claimed_tasks,
      maxRenewalAgeMs: ages.length === 0 ? null : Math.max(...ages),
      minLeaseMarginMs: margins.length === 0 ? null : Math.min(...margins),
    },
  };
}

/**
 * Ends every probe session that is still open, and returns them. A probe that exited closes its
 * sessions; a session that remains belongs to a probe that the driver could not stop.
 */
async function endProbeSessions(
  pool: Pool,
  waitMs: number,
): Promise<{ applicationName: string; pid: number }[]> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const sessions = await pool.query<{ pid: number; application_name: string }>(probeSessionsSql);
    if (sessions.rows.length === 0) return [];
    if (Date.now() >= deadline) {
      await pool.query("SELECT pg_terminate_backend(pid) FROM unnest($1::integer[]) pid", [
        sessions.rows.map((row) => row.pid),
      ]);
      return sessions.rows.map((row) => ({ applicationName: row.application_name, pid: row.pid }));
    }
    await sleep(250);
  }
}

// --- Connection roles ------------------------------------------------------------------------

/**
 * Each probe connection has a role, which shows in what it runs. A listener runs `LISTEN`. A
 * heartbeat round runs `BEGIN`, a `set_config` of `idle_in_transaction_session_timeout`, a
 * `heartbeat_*` statement, and `COMMIT` in every SDK. Other connections run claims, registration,
 * and maintenance. A round takes a few milliseconds, so a sample every 250 ms from the driver
 * misses most rounds. This function samples `pg_stat_activity` in the database, every
 * `p_interval_ms`, with no round trip to the driver. It lives in `pg_temp` of the driver session,
 * so it leaves nothing in the bench database.
 *
 * For each probe backend, it returns its first and last sample, the first sample in which it was
 * absent, the runs of `listen` and `statement` samples, the times of the heartbeat markers, and the
 * start times of each `COMMIT` that it ran. It empties its table with TRUNCATE, so the table does
 * not grow from one call to the next.
 */
const roleSamplerSetupSql = [
  `CREATE TEMP TABLE IF NOT EXISTS wh_bench_seen (
     pid integer NOT NULL, backend_start timestamptz NOT NULL, at timestamptz NOT NULL,
     kind text NOT NULL, query_start timestamptz)`,
  `CREATE OR REPLACE FUNCTION pg_temp.wh_bench_roles(
     p_application_name text, p_duration_ms integer, p_interval_ms integer)
   RETURNS jsonb LANGUAGE plpgsql AS $fn$
   DECLARE
     v_end timestamptz := clock_timestamp() + make_interval(secs => p_duration_ms / 1000.0);
     v_now timestamptz;
     v_times timestamptz[] := '{}';
     v_bytes bigint;
     v_result jsonb;
   BEGIN
     LOOP
       -- pg_stat_activity keeps one snapshot for each transaction unless it is cleared.
       PERFORM pg_stat_clear_snapshot();
       v_now := clock_timestamp();
       v_times := v_times || v_now;
       INSERT INTO wh_bench_seen (pid, backend_start, at, kind, query_start)
       SELECT a.pid, a.backend_start, v_now,
              CASE
                WHEN a.query ~* '^\\s*LISTEN\\s' THEN 'listen'
                WHEN a.query ~ 'heartbeat(_many)?_v[0-9]|idle_in_transaction_session_timeout'
                  THEN 'heartbeat'
                WHEN a.query ~* '^\\s*(COMMIT|END)\\s*;?\\s*$' THEN 'commit'
                WHEN a.query ~* '^\\s*(BEGIN|ROLLBACK|START TRANSACTION)\\s*;?\\s*$'
                  OR a.query = '' THEN 'neutral'
                ELSE 'statement'
              END,
              a.query_start
         FROM pg_stat_activity a
        WHERE a.datname = current_database() AND a.application_name = p_application_name
          AND a.backend_start IS NOT NULL;
       EXIT WHEN clock_timestamp() >= v_end;
       PERFORM pg_sleep(p_interval_ms / 1000.0);
     END LOOP;
     v_bytes := pg_relation_size('wh_bench_seen');
     WITH marked AS (
       SELECT pid, backend_start, at, kind,
              CASE WHEN kind IS DISTINCT FROM lag(kind) OVER own THEN 1 ELSE 0 END AS changed
         FROM wh_bench_seen
        WHERE kind IN ('listen', 'heartbeat', 'statement')
       WINDOW own AS (PARTITION BY pid, backend_start ORDER BY at)
     ), numbered AS (
       SELECT *, sum(changed) OVER (PARTITION BY pid, backend_start ORDER BY at) AS run
         FROM marked
     )
     SELECT jsonb_build_object(
              'iterations', cardinality(v_times),
              'firstIterationMs', extract(epoch FROM v_times[1]) * 1000,
              'lastIterationMs', extract(epoch FROM v_times[cardinality(v_times)]) * 1000,
              'relationBytes', v_bytes,
              'backends', COALESCE((
                SELECT jsonb_agg(to_jsonb(backend)) FROM (
                  SELECT seen.pid AS "pid",
                         extract(epoch FROM seen.backend_start) * 1000 AS "backendStartMs",
                         extract(epoch FROM min(seen.at)) * 1000 AS "firstSeenMs",
                         extract(epoch FROM max(seen.at)) * 1000 AS "lastSeenMs",
                         (SELECT extract(epoch FROM min(t)) * 1000 FROM unnest(v_times) t
                           WHERE t > max(seen.at)) AS "firstAbsentMs",
                         COALESCE(array_agg(DISTINCT extract(epoch FROM seen.at) * 1000)
                           FILTER (WHERE seen.kind = 'heartbeat'), '{}') AS "markersMs",
                         COALESCE(array_agg(DISTINCT extract(epoch FROM seen.query_start) * 1000)
                           FILTER (WHERE seen.kind = 'commit' AND seen.query_start IS NOT NULL),
                           '{}') AS "commitsMs"
                    FROM wh_bench_seen seen GROUP BY seen.pid, seen.backend_start) backend),
                '[]'::jsonb),
              'runs', COALESCE((
                SELECT jsonb_agg(to_jsonb(span)) FROM (
                  SELECT pid AS "pid",
                         extract(epoch FROM backend_start) * 1000 AS "backendStartMs",
                         kind AS "kind",
                         extract(epoch FROM min(at)) * 1000 AS "firstMs",
                         extract(epoch FROM max(at)) * 1000 AS "lastMs"
                    FROM numbered
                   GROUP BY pid, backend_start, run, kind) span), '[]'::jsonb))
       INTO v_result;
     -- DELETE would keep the pages of the table, and no autovacuum runs on a temporary table.
     TRUNCATE wh_bench_seen;
     RETURN v_result;
   END
   $fn$`,
];

/** User and system CPU time of a local process in milliseconds, or null when `/proc` hides it. */
function processCpuMs(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // Fields 14 and 15 of the stat file, counted after the command name: utime and stime, in
    // clock ticks. Linux reports 100 ticks each second.
    return ((Number(fields[11]) + Number(fields[12])) / 100) * 1000;
  } catch {
    return null;
  }
}

interface StartedRoleSampler {
  stop: () => Promise<RoleSampling>;
}

async function startRoleSampler(
  applicationName: string,
  startedAt: number,
): Promise<StartedRoleSampler> {
  const client = new Client({
    connectionString: withApplicationName(databaseUrl, driverApplicationName),
    statement_timeout: roleChunkMs + 5_000,
    query_timeout: roleChunkMs + 5_500,
    connectionTimeoutMillis: 5_000,
  });
  client.on("error", () => {
    // The next call reports the error.
  });
  await client.connect();
  for (const statement of roleSamplerSetupSql) await client.query(statement);
  const backendPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
    .rows[0]!.pid;
  const cpuBefore = processCpuMs(backendPid);
  const sampling = emptyRoleSampling();
  const relative = (epochMs: number): number => epochMs - startedAt;
  const state = { stopping: false };
  const loopStarted = Date.now();
  const loop = (async () => {
    while (!state.stopping) {
      const callStarted = Date.now();
      try {
        const result = await client.query<{ roles: RoleChunk }>(
          "SELECT pg_temp.wh_bench_roles($1, $2, $3) AS roles",
          [applicationName, roleChunkMs, roleSampleIntervalMs],
        );
        const chunk = result.rows[0]!.roles;
        sampling.calls.push({
          startMs: callStarted - startedAt,
          durationMs: chunk.lastIterationMs - chunk.firstIterationMs,
          iterations: chunk.iterations,
          relationBytes: chunk.relationBytes,
        });
        mergeChunk(sampling, chunk, relative);
        sampling.lastIterationMs = relative(chunk.lastIterationMs);
        sampling.failedAfterLastSuccess = false;
      } catch (error) {
        sampling.failedAfterLastSuccess = true;
        if (sampling.errors.length < 5) sampling.errors.push(String(error));
        await sleep(100);
      }
    }
  })();
  return {
    stop: async () => {
      state.stopping = true;
      await loop;
      sampling.durationMs = Date.now() - loopStarted;
      const cpuAfter = processCpuMs(backendPid);
      sampling.backendCpuMs =
        cpuBefore === null || cpuAfter === null ? null : Math.max(0, cpuAfter - cpuBefore);
      await client.end().catch(() => undefined);
      return sampling;
    },
  };
}

// --- Probe process ---------------------------------------------------------------------------

interface ProbeRun {
  exitCode: number | null;
  signal: string | null;
  /** The driver had to send SIGKILL, because the probe did not stop within the grace period. */
  killed: boolean;
  stopMs: number | null;
  events: unknown[];
  stdoutTail: string;
  stderrTail: string;
}

const tailBytes = 4_096;

function appendTail(tail: string, chunk: string): string {
  const joined = tail + chunk;
  return joined.length > tailBytes ? joined.slice(-tailBytes) : joined;
}

interface StartedProbe {
  isRunning: () => boolean;
  /** The pool samples that the probe reported, in order. */
  poolSamples: PoolSample[];
  /** Stops the probe, once. A later call returns the result of the first. */
  stop: () => Promise<ProbeRun>;
}

function startProbe(sdk: string, run: Cell, applicationName: string): StartedProbe {
  const { command, args, cwd } = sdkVariants[sdk]!.probe();
  const spawnedAt = Date.now();
  // The probe leads its own process group, so a signal reaches `mise exec` and every child of it.
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      WH_BENCH_DATABASE_URL: databaseUrl,
      WH_BENCH_APPLICATION_NAME: applicationName,
      WH_BENCH_QUEUE: queueName,
      WH_BENCH_TASK_TYPE: taskType,
      WH_BENCH_WORKERS: String(run.workers),
      WH_BENCH_CONCURRENCY: String(run.concurrency),
      WH_BENCH_POOL_SIZE: String(run.poolSize),
      WH_BENCH_HEARTBEAT_MS: String(run.heartbeatMs),
      WH_BENCH_LEASE_MS: String(run.leaseMs),
    },
  });
  let stdoutTail = "";
  let stderrTail = "";
  let stdoutLine = "";
  const events: unknown[] = [];
  const poolSamples: PoolSample[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutLine += chunk;
    let newline = stdoutLine.indexOf("\n");
    while (newline !== -1) {
      const line = stdoutLine.slice(0, newline).trim();
      stdoutLine = stdoutLine.slice(newline + 1);
      let event: Record<string, unknown> | null = null;
      if (line.startsWith("{")) {
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Not an event line.
        }
      }
      if (event?.["event"] === "pool") {
        poolSamples.push({
          elapsedMs: Date.now() - spawnedAt,
          total: nullableNumber(event["total"]),
          idle: nullableNumber(event["idle"]),
          checkedOut: nullableNumber(event["checkedOut"]),
          waiting: nullableNumber(event["waiting"]),
          max: nullableNumber(event["max"]),
          waitedAcquires: nullableNumber(event["waitedAcquires"]),
        });
      } else {
        stdoutTail = appendTail(stdoutTail, `${line}\n`);
        if (event !== null && events.length < 200) events.push(event);
      }
      newline = stdoutLine.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderrTail = appendTail(stderrTail, chunk);
  });
  let running = true;
  let exitCode: number | null = null;
  let signal: string | null = null;
  const exited = new Promise<void>((resolve) => {
    child.on("exit", (code, exitSignal) => {
      running = false;
      exitCode = code;
      signal = exitSignal;
      resolve();
    });
    child.on("error", (error) => {
      running = false;
      stderrTail = appendTail(stderrTail, `spawn error: ${error.message}\n`);
      resolve();
    });
  });
  const signalGroup = (name: NodeJS.Signals): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, name);
    } catch {
      // The group has exited.
    }
  };
  let stopping: Promise<ProbeRun> | null = null;
  const stop = async (): Promise<ProbeRun> => {
    let killed = false;
    let stopMs: number | null = null;
    if (running) {
      const started = Date.now();
      signalGroup("SIGTERM");
      const stopped = await Promise.race([
        exited.then(() => true),
        sleep(stopGraceMs).then(() => false),
      ]);
      if (!stopped) {
        killed = true;
        signalGroup("SIGKILL");
        await exited;
      }
      stopMs = Date.now() - started;
    }
    // A child of `mise exec` can outlive it; end what remains of the group.
    signalGroup("SIGKILL");
    return { exitCode, signal, killed, stopMs, events, stdoutTail, stderrTail };
  };
  return {
    isRunning: () => running,
    poolSamples,
    stop: async () => {
      stopping ??= stop();
      return await stopping;
    },
  };
}

// --- Cells -----------------------------------------------------------------------------------

function values(samples: readonly Sample[], column: SampleColumn): number[] {
  return samples.map((sample) => sample[column]).filter((value) => value !== null);
}

function maximum(samples: readonly Sample[], column: SampleColumn): number | null {
  const found = values(samples, column);
  return found.length === 0 ? null : Math.max(...found);
}

function minimum(samples: readonly Sample[], column: SampleColumn): number | null {
  const found = values(samples, column);
  return found.length === 0 ? null : Math.min(...found);
}

function spread(samples: readonly Sample[], column: SampleColumn) {
  const found = values(samples, column);
  return {
    min: found.length === 0 ? null : Math.min(...found),
    p50: nearestRankPercentile(found, 0.5),
    max: found.length === 0 ? null : Math.max(...found),
  };
}

async function countLostLeases(pool: Pool): Promise<{
  leaseExpiredAttempts: number;
  leaseExpiredEvents: number;
  otherClosedAttempts: number;
  maxAttempt: number;
}> {
  const result = await pool.query<{
    lease_expired_attempts: number;
    lease_expired_events: number;
    other_closed_attempts: number;
    max_attempt: number;
  }>(
    `SELECT
       (SELECT count(*) FROM workhorse.attempt_history h JOIN workhorse.task t ON t.id = h.task_id
         WHERE t.queue_name = $1 AND h.outcome = 'lease_expired')::integer AS lease_expired_attempts,
       (SELECT count(*) FROM workhorse.task_event e JOIN workhorse.task t ON t.id = e.task_id
         WHERE t.queue_name = $1 AND e.event_type = 'lease_expired')::integer AS lease_expired_events,
       (SELECT count(*) FROM workhorse.attempt_history h JOIN workhorse.task t ON t.id = h.task_id
         WHERE t.queue_name = $1 AND h.outcome <> 'lease_expired')::integer AS other_closed_attempts,
       (SELECT COALESCE(max(current_attempt), 0) FROM workhorse.task_runtime
         WHERE queue_name = $1)::integer AS max_attempt`,
    [queueName],
  );
  const row = result.rows[0]!;
  return {
    leaseExpiredAttempts: row.lease_expired_attempts,
    leaseExpiredEvents: row.lease_expired_events,
    otherClosedAttempts: row.other_closed_attempts,
    maxAttempt: row.max_attempt,
  };
}

/**
 * The longest time, after the first claim, in which slots were free, ready tasks waited, and no
 * claim came. A slot is free when fewer unexpired leases are active than the cell has slots.
 */
function longestClaimGapMs(samples: readonly Sample[], expected: number): number {
  let longest = 0;
  let gapStart: Sample | null = null;
  let claimsSeen = false;
  let previousClaims = 0;
  for (const sample of samples) {
    const claims = sample.claimEvents ?? previousClaims;
    const claimed = claims > previousClaims;
    previousClaims = claims;
    if (claims > 0) claimsSeen = true;
    const waiting =
      claimsSeen &&
      !claimed &&
      (sample.unexpiredActiveTasks ?? expected) < expected &&
      (sample.readyTasks ?? 0) > 0;
    if (!waiting) {
      gapStart = null;
      continue;
    }
    gapStart ??= sample;
    longest = Math.max(longest, sample.elapsedMs - gapStart.elapsedMs);
  }
  return longest;
}

/**
 * The pool state that the probe reported in the measurement window. These counts do not show which
 * connections a worker reserves; `connectionRoles` shows that.
 */
function poolState(measured: readonly Sample[]) {
  const withPool = measured.filter((sample) => sample.poolCheckedOut !== null);
  const outOfPool = spread(withPool, "outOfPoolSessions");
  return {
    samples: withPool.length,
    checkedOut: spread(withPool, "poolCheckedOut"),
    idleCached: spread(withPool, "poolIdle"),
    total: spread(withPool, "poolTotal"),
    waitingMax: maximum(withPool, "poolWaiting"),
    // The pool sample can be up to 250 ms older than the database sample, so one pair can differ
    // while a connection opens or closes. The median is the steady value.
    outOfPoolSessions: {
      ...outOfPool,
      steady: outOfPool.p50 === null ? null : Math.max(0, outOfPool.p50),
    },
  };
}

/** The probe that runs now, so a signal to the driver can stop it. */
let activeProbe: StartedProbe | null = null;

async function stopActiveProbe(): Promise<void> {
  await activeProbe?.stop();
}

async function runCell(pools: DriverPools, sdk: string, run: Cell) {
  const expected = run.workers * run.concurrency;
  const spare = Math.max(2, Math.ceil(expected / 10));
  const applicationName = `wh-bench-${sdk}`;
  const guardWait = await waitForQuietMachine();
  const machineBefore = machineState();
  // A probe from an earlier cell or run must not share this cell.
  const strayBefore = await endProbeSessions(pools.final, 0);
  await resetSchema(pools.admin);
  await enqueueTasks(pools.admin, expected + spare);

  console.error(`${sdk} ${run.id}: start (${expected} slots, ${expected + spare} tasks)`);
  const probe = startProbe(sdk, run, applicationName);
  activeProbe = probe;
  const started = Date.now();
  const driverCpuBefore = process.cpuUsage();
  let roleSampler: StartedRoleSampler | null = null;
  let roleSampling: RoleSampling | null = null;
  let roleSamplerEndMs = 0;
  let roleSamplerError: string | null = null;
  const cellEndMs = run.warmupMs + run.measureMs;
  const sampling: CellSampling = {
    samples: [],
    measuredRenewalAgesMs: [],
    measuredLeaseMarginsMs: [],
    sampleErrors: 0,
    sampleErrorMessages: [],
  };
  let probeExitedEarlyMs: number | null = null;
  let leases: Awaited<ReturnType<typeof countLostLeases>> | null = null;
  let connectionSnapshot: { state: string | null; lastQuery: string; connections: number }[] = [];
  const finalErrors: string[] = [];
  let probeRun: ProbeRun;
  let leftoverSessions: { applicationName: string; pid: number }[] = [];
  try {
    try {
      roleSampler = await startRoleSampler(applicationName, started);
    } catch (error) {
      roleSamplerError = String(error);
    }
    for (let next = started; ; next += sampleIntervalMs) {
      const wait = next - Date.now();
      if (wait > 0) await sleep(wait);
      const elapsedMs = Date.now() - started;
      if (elapsedMs >= cellEndMs) break;
      if (!probe.isRunning() && probeExitedEarlyMs === null) probeExitedEarlyMs = elapsedMs;
      try {
        const { sample, ages, margins } = await takeSample(
          pools.sample,
          applicationName,
          elapsedMs,
          probe.poolSamples.at(-1) ?? null,
        );
        sampling.samples.push(sample);
        if (elapsedMs >= run.warmupMs) {
          sampling.measuredRenewalAgesMs.push(...ages);
          sampling.measuredLeaseMarginsMs.push(...margins);
        }
      } catch (error) {
        sampling.sampleErrors += 1;
        if (sampling.sampleErrorMessages.length < 5) {
          sampling.sampleErrorMessages.push(String(error));
        }
      }
      // A probe that exited holds nothing more. Two seconds of samples show its connections close.
      if (probeExitedEarlyMs !== null && elapsedMs - probeExitedEarlyMs > 2_000) break;
    }
    // The roles describe the running probe, so the sampler stops before the probe.
    if (roleSampler !== null) {
      roleSampling = await roleSampler.stop();
      roleSamplerEndMs = Date.now() - started;
      roleSampler = null;
    }
    try {
      leases = await countLostLeases(pools.final);
    } catch (error) {
      finalErrors.push(`lost leases: ${String(error)}`);
    }
    try {
      connectionSnapshot = (
        await pools.final.query<{ state: string | null; last_query: string; connections: number }>(
          connectionSnapshotSql,
          [applicationName],
        )
      ).rows.map((row) => ({
        state: row.state,
        lastQuery: row.last_query,
        connections: row.connections,
      }));
    } catch (error) {
      finalErrors.push(`connection snapshot: ${String(error)}`);
    }
  } finally {
    if (roleSampler !== null) await roleSampler.stop();
    probeRun = await probe.stop();
    activeProbe = null;
    // The next cell starts only when this probe holds no session.
    leftoverSessions = await endProbeSessions(pools.final, 10_000);
  }
  const machineAfter = machineState();
  const samples = sampling.samples;
  const measured = samples.filter((sample) => sample.elapsedMs >= run.warmupMs);
  const finalSample = samples.at(-1);
  const firstClaim = samples.find((sample) => (sample.claimEvents ?? 0) > 0);
  const fullOccupancy = samples.find((sample) => (sample.unexpiredActiveTasks ?? 0) >= expected);
  const claimGapMs = longestClaimGapMs(samples, expected);
  const percentiles = summarizeLatencies(sampling.measuredRenewalAgesMs);
  const driverCpu = process.cpuUsage(driverCpuBefore);
  const pool = poolState(measured);
  const roles =
    roleSampling === null
      ? null
      : connectionRoles(roleSampling, {
          windowStartMs: run.warmupMs,
          samplerEndMs: roleSamplerEndMs,
          heartbeatMs: run.heartbeatMs,
          commitInference,
        });
  const cellSeconds = roleSamplerEndMs / 1000;
  const outcome = {
    expectedSlots: expected,
    enqueuedTasks: expected + spare,
    finalUnexpiredActiveTasks: finalSample?.unexpiredActiveTasks ?? null,
    finalClaimEvents: finalSample?.claimEvents ?? null,
    finalClaimedTasks: finalSample?.claimedTasks ?? null,
    maxUnexpiredActiveTasks: maximum(samples, "unexpiredActiveTasks"),
    minUnexpiredActiveTasksInWindow: minimum(measured, "unexpiredActiveTasks"),
    firstClaimMs: firstClaim?.elapsedMs ?? null,
    fullOccupancyMs: fullOccupancy?.elapsedMs ?? null,
    // The cell never held W x C unexpired leases at one time.
    initialCapacityFailure: fullOccupancy === undefined,
    // After the first claim, slots stayed free while ready tasks waited and no claim came.
    longestClaimGapMs: claimGapMs,
    progressFailure: claimGapMs >= progressFailureMs,
    lostLeases: leases?.leaseExpiredAttempts ?? null,
    leaseExpiredEvents: leases?.leaseExpiredEvents ?? null,
    otherClosedAttempts: leases?.otherClosedAttempts ?? null,
    maxAttempt: leases?.maxAttempt ?? null,
    maxExpiredActiveTasks: maximum(samples, "expiredActiveTasks"),
    renewalAgeMs: {
      samples: sampling.measuredRenewalAgesMs.length,
      max: round(
        sampling.measuredRenewalAgesMs.length === 0
          ? null
          : sampling.measuredRenewalAgesMs.reduce((left, right) => Math.max(left, right)),
      ),
      p50: round(percentiles.p50),
      p95: round(percentiles.p95),
      p99: round(percentiles.p99),
    },
    minLeaseMarginMs: round(
      sampling.measuredLeaseMarginsMs.length === 0
        ? null
        : sampling.measuredLeaseMarginsMs.reduce((left, right) => Math.min(left, right)),
    ),
    connectionRoles: roles,
    roleSamplerError,
    poolState: pool,
    // The cost of the measurement: the CPU time of the driver process, and of the database backend
    // that runs the role sampler, from the probe start to the end of the window.
    measurementCost: {
      driverCpuMs: round((driverCpu.user + driverCpu.system) / 1000),
      driverCpuPercentOfOneCore:
        cellSeconds === 0
          ? null
          : round((driverCpu.user + driverCpu.system) / 1000 / cellSeconds / 10),
      roleSamplerBackendCpuMs: roleSampling?.backendCpuMs ?? null,
      roleSamplerBackendCpuPercentOfOneCore:
        roleSampling?.backendCpuMs === null || roleSampling === null || cellSeconds === 0
          ? null
          : round(roleSampling.backendCpuMs / cellSeconds / 10),
    },
    maxConnections: {
      total: maximum(samples, "connectionsTotal"),
      active: maximum(samples, "connectionsActive"),
      idle: maximum(samples, "connectionsIdle"),
      idleInTransaction: maximum(samples, "connectionsIdleInTransaction"),
      listen: maximum(samples, "connectionsListen"),
      poolCheckedOut: maximum(samples, "poolCheckedOut"),
      poolWaiting: maximum(samples, "poolWaiting"),
    },
    connectionsAtEnd: connectionSnapshot,
    measuredWindow: {
      samples: measured.length,
      maxConnectionsTotal: maximum(measured, "connectionsTotal"),
    },
    sampleErrors: sampling.sampleErrors,
    sampleErrorMessages: sampling.sampleErrorMessages,
    finalErrors,
    strayProbeSessionsBefore: strayBefore,
    leftoverProbeSessionsAfter: leftoverSessions,
    probe: {
      exitedBeforeStopMs: probeExitedEarlyMs,
      exitCode: probeRun.exitCode,
      signal: probeRun.signal,
      killedAfterGrace: probeRun.killed,
      stopMs: probeRun.stopMs,
      poolSamples: probe.poolSamples.length,
      waitedAcquires: probe.poolSamples.at(-1)?.waitedAcquires ?? null,
      events: probeRun.events,
      stdoutTail: probeRun.stdoutTail,
      stderrTail: probeRun.stderrTail,
    },
  };
  console.error(
    `${sdk} ${run.id}: unexpired ${outcome.finalUnexpiredActiveTasks}/${expected}, sessions ${outcome.maxConnections.total}, roles listen ${JSON.stringify(roles?.listenerConnections)} heartbeat-role ${JSON.stringify(roles?.observedHeartbeatRoleConnections)} peak ${roles?.peakHeartbeatBackendsInOneInterval} former ${JSON.stringify(roles?.formerHeartbeatConnections)} statement ${JSON.stringify(roles?.statementConnections)}, heartbeat starts ${roles?.heartbeatStarts} ends ${roles?.heartbeatEnds}, incomplete ${roles?.heartbeatObservationIncomplete}, sampler interval ${JSON.stringify(roles?.effectiveIntervalMs)} temp bytes ${roles?.maxRelationBytes}, pool idle max ${pool.idleCached.max} waiting max ${pool.waitingMax}, driver CPU ${outcome.measurementCost.driverCpuPercentOfOneCore}% sampler CPU ${outcome.measurementCost.roleSamplerBackendCpuPercentOfOneCore}%, lost leases ${outcome.lostLeases}, capacity failure ${outcome.initialCapacityFailure}, progress failure ${outcome.progressFailure}, exit ${probeRun.exitCode ?? probeRun.signal}`,
  );
  return {
    sdk,
    cell: run,
    applicationName,
    startedAt: new Date(started).toISOString(),
    guardWait,
    machineBefore,
    machineAfter,
    outcome,
    series: {
      columns: sampleColumns,
      rows: samples.map((sample) => sampleColumns.map((column) => round(sample[column]))),
    },
    poolSeries: {
      columns: ["elapsedMs", "total", "idle", "checkedOut", "waiting", "waitedAcquires"],
      rows: probe.poolSamples.map((entry) => [
        entry.elapsedMs,
        entry.total,
        entry.idle,
        entry.checkedOut,
        entry.waiting,
        entry.waitedAcquires,
      ]),
    },
  };
}

// --- Main ------------------------------------------------------------------------------------

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The command, the host, and the source revision. Every SDK is an input, so the whole tree counts. */
function provenance() {
  const status = git([
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ".",
    ":!docs/benchmarks/results",
  ]);
  return {
    command: [...process.argv],
    runtime: {
      nodeVersion: process.version,
      platform: platform(),
      release: release(),
      architecture: arch(),
      cpuModel: cpus()[0]?.model ?? null,
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    source: { commit: git(["rev-parse", "HEAD"]), dirty: status === null ? null : status !== "" },
  };
}

function commandOutput({ command, args, cwd }: ProbeCommand): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    return `unavailable: ${String(error).split("\n")[0]}`;
  }
}

if (process.argv.includes("--help")) {
  console.log(help);
  process.exit(0);
}

const profile = argument("--profile") ?? "smoke";
if (profile !== "smoke" && profile !== "full") throw new Error("--profile must be smoke or full");
const sdks = list("--sdk") ?? Object.keys(sdkVariants);
for (const sdk of sdks) {
  if (!(sdk in sdkVariants)) throw new Error(`unknown --sdk ${sdk}`);
}
const cellFilter = list("--cells");
const cells = profiles[profile].filter((entry) => !cellFilter || cellFilter.includes(entry.id));
if (cells.length === 0) throw new Error("--cells selects no cell of this profile");
const output = argument("--out") ?? `benchmark-connection-budget-${profile}.json`;
// Every probe sends its statements other than heartbeat rounds in autocommit, so only a heartbeat
// round ends with an explicit COMMIT. A probe that adds explicit transactions needs this option.
const commitInference = !process.argv.includes("--no-commit-inference");

console.error(`Connection budget benchmark target: ${databaseName(databaseUrl)}`);
const pools: DriverPools = {
  admin: driverPool(2, 120_000, 10_000),
  sample: driverPool(4, 1_000, 1_000),
  final: driverPool(2, 5_000, 5_000),
};
for (const entry of Object.values(pools)) {
  // An idle driver connection that fails must not end the run; the next query reports it.
  entry.on("error", (error: Error) => {
    console.error(`driver pool error: ${String(error)}`);
  });
}

async function endPools(): Promise<void> {
  await Promise.allSettled(Object.values(pools).map(async (entry) => entry.end()));
}

// A signal to the driver stops the probe that runs, so no probe outlives the driver.
let interrupted = false;
for (const name of ["SIGINT", "SIGTERM"] as const) {
  process.once(name, () => {
    interrupted = true;
    console.error(`${name}: stopping the probe`);
    void stopActiveProbe()
      .then(endPools)
      .finally(() => process.exit(name === "SIGINT" ? 130 : 143));
  });
}

const runs: Awaited<ReturnType<typeof runCell>>[] = [];
let aborted: string | null = null;
try {
  const serverVersion = (await pools.admin.query<{ server_version: string }>("SHOW server_version"))
    .rows[0]!.server_version;
  const maxConnections = (
    await pools.admin.query<{ max_connections: string }>("SHOW max_connections")
  ).rows[0]!.max_connections;
  const toolchains: Record<string, string[]> = {};
  if (!process.argv.includes("--no-build")) {
    for (const sdk of sdks) {
      for (const step of sdkVariants[sdk]!.build) {
        console.error(`build ${sdk}: ${step.command} ${step.args.join(" ")}`);
        const result = spawnSync(step.command, step.args, { cwd: step.cwd, stdio: "inherit" });
        if (result.status !== 0) throw new Error(`build of the ${sdk} probe failed`);
      }
    }
  }
  const sdkVersions: Record<string, string | null> = {};
  for (const sdk of sdks) {
    sdkVersions[sdk] = sdkVersion(sdkVariants[sdk]!);
    toolchains[sdk] = sdkVariants[sdk]!.versions.map(commandOutput);
  }

  const started = Date.now();
  // One cell at a time: the machine is shared, and parallel cells would measure each other.
  try {
    for (const sdk of sdks) {
      for (const entry of cells) {
        if (interrupted) break;
        runs.push(await runCell(pools, sdk, entry));
      }
    }
  } catch (error) {
    // Keep the cells that finished. The artifact names the error.
    aborted = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`run aborted: ${aborted}`);
  }
  const report = {
    benchmark: "connection-budget",
    schemaVersion: 3,
    recordedAt: new Date().toISOString(),
    profile,
    aborted,
    environment: {
      database: databaseName(databaseUrl),
      postgresVersion: serverVersion,
      maxConnections: Number(maxConnections),
    },
    provenance: provenance(),
    sdkVersions,
    toolchains,
    settings: {
      queue: queueName,
      taskType,
      sampleIntervalMs,
      stopGraceMs,
      progressFailureMs,
      roleSampleIntervalMs,
      roleChunkMs,
      commitInference,
      guard,
      sdks,
      matrix: cells,
    },
    wallTimeMs: Date.now() - started,
    runs,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`Wrote ${output}`);
  if (aborted !== null) process.exitCode = 1;
} finally {
  await stopActiveProbe();
  await endPools();
}
