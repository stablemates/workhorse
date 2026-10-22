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
  type AttemptRecords,
  attributeFaultClaims,
  type BackendIdentity,
  type CellFacts,
  type CellKind,
  cellResult,
  type Claim,
  type ClosedAttempt,
  connectionRoles,
  dispatchAllowanceMs,
  emptyRoleSampling,
  faultRecovery,
  heartbeatReadyIntervals,
  heartbeatRoleBackendsAt,
  type Interval,
  latestNextSlot,
  mergeChunk,
  refillClaimGapLimitMs,
  refillPollMs,
  replayDispatch,
  type RoleChunk,
  roleChunkMs,
  roleSampleIntervalMs,
  type RoleSampling,
  round,
  watchdogVerdict,
  type WorkerStart,
} from "./connection-budget-roles.js";

const help = `Workhorse connection budget benchmark

Starts the probe of one SDK for each cell of a matrix. A probe runs W workers in one process on
one pool of P connections, with concurrency C, heartbeat interval I, and lease L. In a held-task
cell every handler sleeps until the probe stops. In a refill cell every handler finishes after a
fixed time, so the workers claim again. A fault cell ends the heartbeat connection of a refill
workload once. Every 250 ms the driver samples pg_stat_activity and workhorse.task_runtime, and
records the pool state that the probe reports. A role sampler in the database reads
pg_stat_activity about every 2 ms to find the listener and heartbeat connections. The driver
gives each cell a result, pass, fail, or inconclusive, and writes one JSON artifact with a summary
table. Cells run
one at a time. Before each cell the driver waits while the 1-minute load is above 16 or available
memory is below 8 GB.

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
/**
 * The shutdown grace that the driver gives every probe. The driver sends SIGKILL when the probe
 * has not exited this long, plus the unwind window of its SDK, plus `killMarginMs`, after SIGTERM.
 */
const shutdownGraceMs = 10_000;
const killMarginMs = 5_000;
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
  /**
   * The time that the SDK documents for its stop after the shutdown grace, and where it says so.
   * The kill deadline of the driver is the grace, plus this window, plus 5 s.
   */
  unwind: { ms: number; source: string };
}

/**
 * The TypeScript and Python workers have no shutdown grace. Their process runners exit the process
 * with status 1 when the grace passes, and the probes do the same.
 */
const noGraceUnwind = (runner: string) => ({
  ms: 0,
  source: `${runner}; no unwind window after the grace`,
});

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
    unwind: noGraceUnwind(
      "python/src/workhorse/worker_process.py: run_worker_process exits at shutdown_timeout_ms",
    ),
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
    unwind: noGraceUnwind(
      "typescript/core/src/worker-process.ts: runWorkerProcess exits at shutdownTimeoutMs",
    ),
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
    unwind: {
      ms: 2_250,
      source:
        "docs/architecture/schema-and-protocol.md, Go shutdown grace period and listener: a 250 ms unwind, deregister_worker_v2 for at most 1,000 ms, and UNLISTEN for at most 1,000 ms (go/worker.go handlerUnwindPeriod, deregistrationTimeout)",
    },
  },
  ruby: {
    build: [mise(["bundle", "install", "--quiet"], join(root, "ruby"))],
    probe: () =>
      mise(["bundle", "exec", "ruby", "tools/connection_budget_probe.rb"], join(root, "ruby")),
    versions: [mise(["ruby", "--version"])],
    manifest: ["ruby/lib/stablemates/workhorse/version.rb", /VERSION = "([^"]+)"/],
    unwind: {
      ms: 250,
      source:
        "docs/architecture/schema-and-protocol.md, Ruby shutdown: a 250 millisecond unwind window (ruby/lib/stablemates/workhorse/worker.rb UNWIND_WINDOW)",
    },
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
    unwind: {
      ms: 1_250,
      source:
        "docs/architecture/schema-and-protocol.md, Rust shutdown: a 250 ms unwind, then a cleanup window that ends 1 second after the deadline (rust/src/worker/mod.rs UNWIND_WINDOW, CLEANUP_WINDOW)",
    },
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
    unwind: {
      ms: 2_000,
      source:
        "docs/architecture/schema-and-protocol.md, JVM shutdown: a complete shutdown can end up to about 2 seconds after shutdownGrace",
    },
  },
};

// --- Matrix ----------------------------------------------------------------------------------

interface Cell {
  id: string;
  kind: CellKind;
  workers: number;
  concurrency: number;
  poolSize: number;
  heartbeatMs: number;
  leaseMs: number;
  /** Time from the probe start to the start of the measurement window. */
  warmupMs: number;
  /**
   * Length of the measurement window. A held-task cell ends when it closes. A refill cell ends
   * earlier when no task remains, and a fault cell when its observation after the fault ends.
   */
  measureMs: number;
  /**
   * Refill and fault cells: the time that each handler runs before it returns. The payload of each
   * task carries it; a held task has none.
   */
  handlerMs: number | null;
  /** Fault cells: every `every`-th task runs `ms` instead, so leases need renewal. */
  longHandler: { ms: number; every: number } | null;
  /** Refill and fault cells: the tasks for each slot, so that each slot claims many times. */
  tasksPerSlot: number | null;
  /** The polling interval that the probe sets, or null for the default of the SDK. */
  pollMs: number | null;
  /** Fault cells: how long the driver observes after the fault. */
  faultObserveMs: number | null;
}

type Shape = Pick<Cell, "workers" | "concurrency" | "poolSize" | "heartbeatMs" | "leaseMs">;

function held(id: string, shape: Shape, warmupMs: number, measureMs: number): Cell {
  return {
    id,
    kind: "held",
    ...shape,
    warmupMs,
    measureMs,
    handlerMs: null,
    longHandler: null,
    tasksPerSlot: null,
    pollMs: null,
    faultObserveMs: null,
  };
}

/**
 * A refill cell. Handlers return after 1.2 s, so a heartbeat round renews each task at least once.
 */
function refill(id: string, shape: Shape, tasksPerSlot: number): Cell {
  return {
    id,
    kind: "refill",
    ...shape,
    warmupMs: 5_000,
    measureMs: 25_000 + tasksPerSlot * 3_000,
    handlerMs: 1_200,
    longHandler: null,
    tasksPerSlot,
    pollMs: refillPollMs,
    faultObserveMs: null,
  };
}

/**
 * A fault cell at the default timing, I = 10 s and L = 30 s. One task in four runs 15 s, so its
 * lease needs renewal through the fault. The other tasks run 1 s, so claims come often. Each slot
 * has more tasks than the cell can finish, so claims go on through the fault. The fault comes at
 * the first heartbeat round after the warm-up, and the driver observes for 3 x I after it.
 */
function faultCell(id: string, shape: Pick<Shape, "workers" | "concurrency" | "poolSize">): Cell {
  return {
    id,
    kind: "fault",
    ...shape,
    heartbeatMs: 10_000,
    leaseMs: 30_000,
    warmupMs: 15_000,
    measureMs: 70_000,
    handlerMs: 1_000,
    longHandler: { ms: 15_000, every: 4 },
    tasksPerSlot: 25,
    pollMs: refillPollMs,
    faultObserveMs: 30_000,
  };
}

const fastTiming = { heartbeatMs: 1_000, leaseMs: 3_000 };

const profiles: Record<"smoke" | "full", Cell[]> = {
  smoke: [
    held(
      "smoke-w2-c2-p20",
      { workers: 2, concurrency: 2, poolSize: 20, ...fastTiming },
      5_000,
      15_000,
    ),
    refill(
      "smoke-refill-w2-c2-p20",
      { workers: 2, concurrency: 2, poolSize: 20, ...fastTiming },
      10,
    ),
    faultCell("smoke-fault-w4-c4-p20", { workers: 4, concurrency: 4, poolSize: 20 }),
  ],
  full: [
    held(
      "starvation-w2-c1-p4",
      { workers: 2, concurrency: 1, poolSize: 4, ...fastTiming },
      10_000,
      30_000,
    ),
    ...[1, 4, 16, 64].flatMap((workers) =>
      [1, 25].map((concurrency) =>
        held(
          `capacity-w${workers}-c${concurrency}-p20`,
          { workers, concurrency, poolSize: 20, ...fastTiming },
          15_000,
          60_000,
        ),
      ),
    ),
    ...[16, 64].map((workers) =>
      held(
        `default-timing-w${workers}-c25-p20`,
        { workers, concurrency: 25, poolSize: 20, heartbeatMs: 10_000, leaseMs: 30_000 },
        20_000,
        180_000,
      ),
    ),
    refill("refill-w2-c1-p4", { workers: 2, concurrency: 1, poolSize: 4, ...fastTiming }, 20),
    refill("refill-w4-c2-p6", { workers: 4, concurrency: 2, poolSize: 6, ...fastTiming }, 20),
    refill("refill-w16-c4-p20", { workers: 16, concurrency: 4, poolSize: 20, ...fastTiming }, 20),
    faultCell("fault-w16-c4-p20", { workers: 16, concurrency: 4, poolSize: 20 }),
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

/**
 * The handler time of task `index`, which its payload carries. A task without one is held until the
 * probe stops.
 */
function taskHandlerMs(run: Cell, index: number): number | null {
  if (run.handlerMs === null) return null;
  return run.longHandler !== null && index % run.longHandler.every === 0
    ? run.longHandler.ms
    : run.handlerMs;
}

async function enqueueTasks(pool: Pool, run: Cell, count: number): Promise<void> {
  const queue = new Queue(pool, queueName);
  for (let offset = 0; offset < count; offset += 1_000) {
    const size = Math.min(1_000, count - offset);
    await queue.enqueueMany(
      Array.from({ length: size }, (_, index) => ({
        type: taskType,
        payload: { index: offset + index, handlerMs: taskHandlerMs(run, offset + index) },
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
// Only an accepted renewal changes `heartbeat_at` and `expires_at`, so the samples give the last
// accepted renewal and the deadline of each attempt.
const leasesSql = `
  SELECT (extract(epoch FROM clock_timestamp() - heartbeat_at) * 1000)::double precision AS age_ms,
         (extract(epoch FROM expires_at - clock_timestamp()) * 1000)::double precision AS margin_ms,
         task_id::text || ':' || fence_token::text AS attempt,
         (extract(epoch FROM heartbeat_at) * 1000)::double precision AS renewal_ms,
         (extract(epoch FROM expires_at) * 1000)::double precision AS deadline_ms,
         (extract(epoch FROM clock_timestamp()) * 1000)::double precision AS sampled_ms
    FROM workhorse.task_runtime
   WHERE queue_name = $1 AND state = 'active'`;

/** The last sample of one attempt, with epoch times from the database. */
interface AttemptSample {
  renewalMs: number;
  deadlineMs: number;
  sampledMs: number;
}

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
  /** The last sample of each attempt, by task and fence token. */
  attempts: Map<string, AttemptSample>;
  /** The attempts in the last sample whose deadline was after it, and the time of that sample. */
  liveAtEnd: string[];
  lastAttemptSampleMs: number | null;
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
): Promise<{
  sample: Sample;
  ages: number[];
  margins: number[];
  attempts: [string, AttemptSample][];
}> {
  const [connections, leases, claims] = await Promise.all([
    pool.query<ConnectionCounts>(connectionsSql, [applicationName]),
    pool.query<{
      age_ms: number;
      margin_ms: number;
      attempt: string;
      renewal_ms: number;
      deadline_ms: number;
      sampled_ms: number;
    }>(leasesSql, [queueName]),
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
    attempts: leases.rows.map((row) => [
      row.attempt,
      { renewalMs: row.renewal_ms, deadlineMs: row.deadline_ms, sampledMs: row.sampled_ms },
    ]),
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
/** The statements of a heartbeat round: the `heartbeat` kind of the role sampler. */
const heartbeatMarkerPattern = "heartbeat(_many)?_v[0-9]|idle_in_transaction_session_timeout";

const roleSamplerSetupSql = [
  `CREATE TEMP TABLE IF NOT EXISTS wh_bench_seen (
     pid integer NOT NULL, backend_start timestamptz NOT NULL, at timestamptz NOT NULL,
     kind text NOT NULL, query_start timestamptz, state text, state_change timestamptz)`,
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
       INSERT INTO wh_bench_seen (pid, backend_start, at, kind, query_start, state, state_change)
       SELECT a.pid, a.backend_start, v_now,
              CASE
                WHEN a.query ~* '^\\s*LISTEN\\s' THEN 'listen'
                WHEN a.query ~ '${heartbeatMarkerPattern}' THEN 'heartbeat'
                WHEN a.query ~* '^\\s*(COMMIT|END)\\s*;?\\s*$' THEN 'commit'
                WHEN a.query ~* '^\\s*(BEGIN|ROLLBACK|START TRANSACTION)\\s*;?\\s*$'
                  OR a.query = '' THEN 'neutral'
                ELSE 'statement'
              END,
              a.query_start, a.state, a.state_change
         FROM pg_stat_activity a
        WHERE a.datname = current_database() AND a.application_name = p_application_name
          AND a.backend_start IS NOT NULL;
       EXIT WHEN clock_timestamp() >= v_end;
       PERFORM pg_sleep(p_interval_ms / 1000.0);
     END LOOP;
     v_bytes := pg_relation_size('wh_bench_seen');
     WITH marked AS (
       SELECT pid, backend_start, at, kind, state, state_change,
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
                         extract(epoch FROM max(at)) * 1000 AS "lastMs",
                         -- An idle backend keeps the text of its last statement. Its state_change
                         -- is when that statement ended, so only a running sample or that end
                         -- time shows a use.
                         extract(epoch FROM max(CASE WHEN state = 'idle' THEN state_change
                                                     ELSE at END)) * 1000 AS "lastUseMs"
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
  /** The observations so far. They grow after each call of the sampler. */
  sampling: RoleSampling;
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
    sampling,
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

// --- Fault -----------------------------------------------------------------------------------

/**
 * The fault of a fault cell. The function reads `pg_stat_activity` about every millisecond, with
 * the marker of the role sampler, until a probe backend runs a heartbeat round. Then it ends that
 * backend with `pg_terminate_backend`. The round fails immediately, so the SDK knows of the loss
 * at the time of the fault, and not only at its next round. Like the role sampler, the function
 * lives in `pg_temp` of a driver session.
 *
 * Just before it ends the backend, the function records the other statements of the probe that are
 * running: a claim from one of them can come after the fault although the statement started
 * before it. Then it reads `pg_stat_activity` until each of those statements has ended, for at most
 * `faultWatchMs`, and returns that time.
 */
/** How long the fault function waits for the statements that run at the fault to end. */
const faultWatchMs = 3_000;

const faultSetupSql = `
  CREATE OR REPLACE FUNCTION pg_temp.wh_bench_end_heartbeat(
    p_application_name text, p_timeout_ms integer)
  RETURNS jsonb LANGUAGE plpgsql AS $fn$
  DECLARE
    v_end timestamptz := clock_timestamp() + make_interval(secs => p_timeout_ms / 1000.0);
    v_found record;
    v_at timestamptz;
    v_in_flight jsonb;
    v_open integer;
    v_watch_end timestamptz;
  BEGIN
    LOOP
      PERFORM pg_stat_clear_snapshot();
      SELECT a.pid, a.backend_start, a.state, left(a.query, 120) AS query,
             a.xact_start, a.query_start INTO v_found
        FROM pg_stat_activity a
       WHERE a.datname = current_database() AND a.application_name = p_application_name
         AND a.state <> 'idle' AND a.query ~ '${heartbeatMarkerPattern}'
       LIMIT 1;
      IF FOUND THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'pid', a.pid, 'queryStart', a.query_start,
                 'queryStartMs', extract(epoch FROM a.query_start) * 1000,
                 'state', a.state, 'query', left(a.query, 120))), '[]'::jsonb)
          INTO v_in_flight
          FROM pg_stat_activity a
         WHERE a.datname = current_database() AND a.application_name = p_application_name
           AND a.pid <> v_found.pid AND a.state <> 'idle'
           AND a.query !~* '^\\s*LISTEN\\s' AND a.query !~ '${heartbeatMarkerPattern}';
        v_at := clock_timestamp();
        IF pg_terminate_backend(v_found.pid) THEN
          v_watch_end := clock_timestamp() + make_interval(secs => ${faultWatchMs} / 1000.0);
          LOOP
            PERFORM pg_stat_clear_snapshot();
            SELECT count(*) INTO v_open
              FROM jsonb_array_elements(v_in_flight) flight
              JOIN pg_stat_activity a ON a.pid = (flight->>'pid')::integer
             WHERE a.query_start = (flight->>'queryStart')::timestamptz AND a.state <> 'idle';
            EXIT WHEN v_open = 0 OR clock_timestamp() >= v_watch_end;
            PERFORM pg_sleep(0.001);
          END LOOP;
          RETURN jsonb_build_object(
            'pid', v_found.pid,
            'backendStartMs', extract(epoch FROM v_found.backend_start) * 1000,
            'atMs', extract(epoch FROM v_at) * 1000,
            'state', v_found.state,
            'query', v_found.query,
            'roundStartMs', extract(epoch FROM COALESCE(v_found.xact_start, v_found.query_start))
              * 1000,
            'inFlight', v_in_flight,
            'inFlightEndedMs', extract(epoch FROM clock_timestamp()) * 1000,
            'inFlightOpen', v_open);
        END IF;
      END IF;
      EXIT WHEN clock_timestamp() >= v_end;
      PERFORM pg_sleep(0.001);
    END LOOP;
    RETURN NULL;
  END
  $fn$`;

interface FaultRecord {
  /** When the driver started to look for a heartbeat round. */
  armedMs: number;
  /** When the first backend ended, or when the search ended without a round. */
  atMs: number;
  /** No backend ran a heartbeat round in the search time. */
  searchTimedOut: boolean;
  /** The backend that a round was running on, and its state and statement at the fault. */
  inRound: (BackendIdentity & { state: string; query: string }) | null;
  /** The start of the interrupted round: the `xact_start` of its backend at the fault. */
  roundStartMs: number | null;
  /** The other backends with the heartbeat role at the fault, which the driver also ended. */
  roleBackends: BackendIdentity[];
  /** When the query that ended `roleBackends` returned. */
  roleBackendsEndedMs: number | null;
  /** The other statements of the probe that were running at the fault, with their start times. */
  inFlight: { pid: number; queryStartMs: number; state: string; query: string }[];
  /**
   * When every statement of `inFlight` had ended. Null when it is not known: no round was found,
   * or a statement still ran when the watch ended.
   */
  inFlightEndedMs: number | null;
  error: string | null;
}

/**
 * Ends the heartbeat connections of the probe once: the backend that runs the next heartbeat round,
 * and each other backend that has the heartbeat role in the observations of the role sampler. No
 * other probe backend ends, and the database stays reachable.
 */
async function injectFault(
  applicationName: string,
  run: Cell,
  started: number,
  sampler: StartedRoleSampler | null,
  final: Pool,
): Promise<FaultRecord> {
  const armedMs = Date.now() - started;
  const record: FaultRecord = {
    armedMs,
    atMs: armedMs,
    searchTimedOut: false,
    inRound: null,
    roundStartMs: null,
    roleBackends: [],
    roleBackendsEndedMs: null,
    inFlight: [],
    inFlightEndedMs: null,
    error: null,
  };
  const searchMs = 2 * run.heartbeatMs + 2_000;
  const client = new Client({
    connectionString: withApplicationName(databaseUrl, driverApplicationName),
    statement_timeout: searchMs + faultWatchMs + 5_000,
    query_timeout: searchMs + faultWatchMs + 5_500,
    connectionTimeoutMillis: 5_000,
  });
  client.on("error", () => {
    // The query reports the error.
  });
  try {
    await client.connect();
    await client.query(faultSetupSql);
    const found = (
      await client.query<{
        ended: {
          pid: number;
          backendStartMs: number;
          atMs: number;
          state: string;
          query: string;
          roundStartMs: number | null;
          inFlight: { pid: number; queryStartMs: number; state: string; query: string }[];
          inFlightEndedMs: number;
          inFlightOpen: number;
        } | null;
      }>("SELECT pg_temp.wh_bench_end_heartbeat($1, $2) AS ended", [applicationName, searchMs])
    ).rows[0]!.ended;
    if (found === null) {
      record.searchTimedOut = true;
      record.atMs = Date.now() - started;
    } else {
      record.atMs = found.atMs - started;
      record.inRound = {
        pid: found.pid,
        backendStartMs: found.backendStartMs - started,
        state: found.state,
        query: found.query,
      };
      record.roundStartMs = found.roundStartMs === null ? null : found.roundStartMs - started;
      record.inFlight = found.inFlight.map((entry) => ({
        ...entry,
        queryStartMs: entry.queryStartMs - started,
      }));
      record.inFlightEndedMs = found.inFlightOpen === 0 ? found.inFlightEndedMs - started : null;
    }
    if (sampler !== null) {
      const others = heartbeatRoleBackendsAt(
        sampler.sampling,
        {
          windowStartMs: 0,
          samplerEndMs: sampler.sampling.lastIterationMs ?? record.atMs,
          heartbeatMs: run.heartbeatMs,
          commitInference,
        },
        record.atMs,
      ).filter((backend) => backend.pid !== record.inRound?.pid);
      if (others.length > 0) {
        // The CTE selects the targets first. PostgreSQL can test the conditions of one WHERE
        // clause in any order, so pg_terminate_backend must not share a WHERE clause with them.
        const ended = await final.query<{ pid: number; ended: boolean }>(
          `WITH target AS MATERIALIZED (
             SELECT a.pid FROM pg_stat_activity a
              WHERE a.pid = ANY($1::integer[]) AND a.application_name = $2
                AND a.datname = current_database() AND a.pid <> pg_backend_pid())
           SELECT pid, pg_terminate_backend(pid) AS ended FROM target`,
          [others.map((backend) => backend.pid), applicationName],
        );
        const endedPids = new Set(ended.rows.filter((row) => row.ended).map((row) => row.pid));
        record.roleBackends = others.filter((backend) => endedPids.has(backend.pid));
        record.roleBackendsEndedMs = Date.now() - started;
        if (record.inRound === null && record.roleBackends.length > 0) {
          record.atMs = Date.now() - started;
        }
      }
    }
  } catch (error) {
    record.error = String(error);
  } finally {
    await client.end().catch(() => undefined);
  }
  return record;
}

// --- Probe process ---------------------------------------------------------------------------

interface ProbeRun {
  exitCode: number | null;
  signal: string | null;
  /** The driver had to send SIGKILL, because the probe did not stop by the kill deadline. */
  killed: boolean;
  stopMs: number | null;
  /** The time after SIGTERM at which the driver sends SIGKILL. */
  killDeadlineMs: number;
  /** Every `worker_error` line of the probe. `events` keeps only the first 200 events. */
  workerErrors: number;
  /** The `worker_error` and `shutdown_incomplete` lines after SIGTERM. */
  errorsAfterStop: number;
  /** The `started` event, which names the settings that the probe applied. */
  started: Record<string, unknown> | null;
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

/** The time after SIGTERM at which the driver sends SIGKILL to a probe of `sdk`. */
function killDeadlineMs(sdk: string): number {
  return shutdownGraceMs + sdkVariants[sdk]!.unwind.ms + killMarginMs;
}

function startProbe(sdk: string, run: Cell, applicationName: string): StartedProbe {
  const { command, args, cwd } = sdkVariants[sdk]!.probe();
  const deadlineMs = killDeadlineMs(sdk);
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
      WH_BENCH_SHUTDOWN_GRACE_MS: String(shutdownGraceMs),
      WH_BENCH_POLL_MS: run.pollMs === null ? "" : String(run.pollMs),
    },
  });
  let stdoutTail = "";
  let stderrTail = "";
  let stdoutLine = "";
  const events: unknown[] = [];
  const poolSamples: PoolSample[] = [];
  let workerErrors = 0;
  let errorsAfterStop = 0;
  let stopSent = false;
  let startedEvent: Record<string, unknown> | null = null;
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
        if (event?.["event"] === "worker_error") workerErrors += 1;
        if (
          stopSent &&
          (event?.["event"] === "worker_error" || event?.["event"] === "shutdown_incomplete")
        ) {
          errorsAfterStop += 1;
        }
        if (event?.["event"] === "started") startedEvent ??= event;
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
      stopSent = true;
      signalGroup("SIGTERM");
      const stopped = await Promise.race([
        exited.then(() => true),
        sleep(deadlineMs).then(() => false),
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
    return {
      exitCode,
      signal,
      killed,
      stopMs,
      killDeadlineMs: deadlineMs,
      workerErrors,
      errorsAfterStop,
      started: startedEvent,
      events,
      stdoutTail,
      stderrTail,
    };
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
 * The claims, the closed attempts, and the workers of the queue, with their times from the cell
 * start. A claim writes its `claimed` event and a settlement writes its attempt history row with
 * `clock_timestamp()`, so these times are more exact than the samples. The `expires_at` of a claim
 * event is the start of its claim function plus the lease. A worker has slots from its registration
 * in `workhorse.worker_registry`. The times are relative to the clock of the driver, so PostgreSQL
 * must run on the same host.
 */
async function claimTimeline(
  pool: Pool,
  started: number,
  leaseMs: number,
): Promise<{
  claims: (Claim & { attempt: string })[];
  closes: (ClosedAttempt & { outcome: string; claimedAtMs: number; attempt: string })[];
  workers: WorkerStart[];
}> {
  const claims = await pool.query<{
    at_ms: number;
    acquired_ms: number | null;
    worker: string | null;
    attempt: string;
  }>(
    `SELECT extract(epoch FROM e.occurred_at)::double precision * 1000 AS at_ms,
            e.task_id::text || ':' || (e.details->>'fence_token') AS attempt,
            extract(epoch FROM (e.details->>'expires_at')::timestamptz)::double precision * 1000
              - $2::double precision AS acquired_ms,
            e.details->>'worker_id' AS worker
       FROM workhorse.task_event e JOIN workhorse.task t ON t.id = e.task_id
      WHERE t.queue_name = $1 AND e.event_type = 'claimed'
      ORDER BY 1`,
    [queueName, leaseMs],
  );
  const closes = await pool.query<{
    at_ms: number;
    claimed_at_ms: number;
    worker: string;
    outcome: string;
    attempt: string;
  }>(
    `SELECT extract(epoch FROM h.finished_at)::double precision * 1000 AS at_ms,
            extract(epoch FROM h.claimed_at)::double precision * 1000 AS claimed_at_ms,
            h.worker_id AS worker, h.outcome,
            h.task_id::text || ':' || h.fence_token::text AS attempt
       FROM workhorse.attempt_history h JOIN workhorse.task t ON t.id = h.task_id
      WHERE t.queue_name = $1
      ORDER BY 1`,
    [queueName],
  );
  const workers = await pool.query<{ worker: string; started_ms: number }>(
    `SELECT worker_id AS worker,
            extract(epoch FROM started_at)::double precision * 1000 AS started_ms
       FROM workhorse.worker_registry
      WHERE queue_name = $1`,
    [queueName],
  );
  return {
    claims: claims.rows.map((row) => ({
      atMs: row.at_ms - started,
      worker: row.worker ?? "",
      acquiredMs: row.acquired_ms === null ? null : row.acquired_ms - started,
      attempt: row.attempt,
    })),
    closes: closes.rows.map((row) => ({
      atMs: row.at_ms - started,
      claimedAtMs: row.claimed_at_ms - started,
      worker: row.worker,
      outcome: row.outcome,
      attempt: row.attempt,
      // The probe allows 100 attempts, so these outcomes make the task ready again.
      returnsToReady: ["retry", "lease_expired", "timeout"].includes(row.outcome),
    })),
    workers: workers.rows.map((row) => ({ worker: row.worker, atMs: row.started_ms - started })),
  };
}

/**
 * For each task: its completions, its attempts, and its claims. A refill cell passes only when
 * each task completed once, with one attempt and one claim, and no task remains.
 */
async function completionCounts(pool: Pool) {
  const perTask = await pool.query<{
    attempts: number;
    succeeded: number;
    claims: number;
    tasks: number;
  }>(
    `SELECT counts.attempts, counts.succeeded, counts.claims, count(*)::integer AS tasks
       FROM workhorse.task t
       CROSS JOIN LATERAL (
         SELECT (SELECT count(*) FROM workhorse.attempt_history h
                  WHERE h.task_id = t.id)::integer AS attempts,
                (SELECT count(*) FROM workhorse.attempt_history h
                  WHERE h.task_id = t.id AND h.outcome = 'succeeded')::integer AS succeeded,
                (SELECT count(*) FROM workhorse.task_event e
                  WHERE e.task_id = t.id AND e.event_type = 'claimed')::integer AS claims) counts
      WHERE t.queue_name = $1
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3`,
    [queueName],
  );
  const remaining = await pool.query<{ state: string; tasks: number }>(
    `SELECT state, count(*)::integer AS tasks FROM workhorse.task_runtime
      WHERE queue_name = $1 GROUP BY state`,
    [queueName],
  );
  const rows = perTask.rows;
  const sum = (pick: (row: (typeof rows)[number]) => boolean) =>
    rows.filter(pick).reduce((total, row) => total + row.tasks, 0);
  const remainingIn = (state: string) =>
    remaining.rows.find((row) => row.state === state)?.tasks ?? 0;
  return {
    tasks: sum(() => true),
    completedOnce: sum((row) => row.succeeded === 1 && row.attempts === 1 && row.claims === 1),
    completed: sum((row) => row.succeeded >= 1),
    completedMoreThanOnce: sum((row) => row.succeeded > 1),
    tasksWithMoreThanOneAttempt: sum((row) => row.attempts > 1),
    tasksWithMoreThanOneClaim: sum((row) => row.claims > 1),
    neverClaimed: sum((row) => row.claims === 0),
    remainingActive: remainingIn("active"),
    remainingReady: remainingIn("ready"),
    // Each combination of completions, closed attempts, and claims, with its count of tasks.
    perTask: rows,
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

/** What a refill cell shows: the completions and attempts of each task, and the claim gaps. */
/**
 * The one replay of the dispatch state of a cell: the claim gaps of each worker, and the times in
 * which some worker had a free slot and a task was ready. Null without the timeline.
 */
function dispatchReplay(
  run: Cell,
  enqueued: number,
  endMs: number,
  timeline: Awaited<ReturnType<typeof claimTimeline>> | null,
  ready: readonly Interval[],
) {
  if (timeline === null) return null;
  return replayDispatch({
    claims: timeline.claims,
    closes: timeline.closes,
    tasks: enqueued,
    workers: timeline.workers,
    slotsPerWorker: run.concurrency,
    readiness: { ready, notReady: [] },
    endMs,
  });
}

function refillResult(
  run: Cell,
  enqueued: number,
  timeline: Awaited<ReturnType<typeof claimTimeline>> | null,
  completion: Awaited<ReturnType<typeof completionCounts>> | null,
  replay: ReturnType<typeof dispatchReplay>,
  ready: readonly Interval[],
) {
  if (run.kind !== "refill") return null;
  const closedAttempts: Record<string, number> = {};
  for (const close of timeline?.closes ?? []) {
    closedAttempts[close.outcome] = (closedAttempts[close.outcome] ?? 0) + 1;
  }
  return {
    handlerMs: run.handlerMs,
    tasksPerSlot: run.tasksPerSlot,
    // Every enqueued task must complete, also when the count of tasks fails.
    tasks: enqueued,
    tasksFound: completion?.tasks ?? null,
    completedOnce: completion?.completedOnce ?? 0,
    completed: completion?.completed ?? null,
    completedMoreThanOnce: completion?.completedMoreThanOnce ?? null,
    tasksWithMoreThanOneAttempt: completion?.tasksWithMoreThanOneAttempt ?? null,
    tasksWithMoreThanOneClaim: completion?.tasksWithMoreThanOneClaim ?? null,
    neverClaimed: completion?.neverClaimed ?? null,
    remainingActive: completion?.remainingActive ?? null,
    remainingReady: completion?.remainingReady ?? null,
    perTask: completion?.perTask ?? null,
    claimEvents: timeline?.claims.length ?? null,
    closedAttempts,
    claimGapLimitMs: refillClaimGapLimitMs,
    workers: timeline?.workers ?? null,
    // The times with an observed heartbeat role. Other times have an unknown readiness.
    readyIntervals: ready.map((entry) => ({
      fromMs: round(entry.fromMs),
      toMs: round(entry.toMs),
    })),
    // Without the timeline the gaps are unknown, and an infinite gap fails the rule.
    certainGap: replay?.certain ?? {
      lengthMs: Number.POSITIVE_INFINITY,
      startMs: null,
      endMs: null,
      worker: null,
    },
    possibleGap: replay?.possible ?? {
      lengthMs: Number.POSITIVE_INFINITY,
      startMs: null,
      endMs: null,
      worker: null,
    },
  };
}

/**
 * What a fault cell shows. The fault ends the heartbeat connections, and the database stays
 * reachable, so the outage is the time without a usable heartbeat reservation. It starts at the
 * fault. The driver cannot see when the replacement is ready: `faultRecovery` gives a lower and an
 * upper bound. The result reads the claims after the fault, each with the start of its claim
 * function, and the end of the statements that ran at the fault.
 */
function faultResult(
  run: Cell,
  started: number,
  endMs: number,
  record: FaultRecord | null,
  timeline: Awaited<ReturnType<typeof claimTimeline>> | null,
  sampling: RoleSampling | null,
  driverSampling: CellSampling,
  options: Parameters<typeof connectionRoles>[1],
  roles: ReturnType<typeof connectionRoles> | null,
  replay: ReturnType<typeof dispatchReplay>,
) {
  if (run.kind !== "fault") return null;
  const terminated: BackendIdentity[] =
    record === null
      ? []
      : [...(record.inRound === null ? [] : [record.inRound]), ...record.roleBackends];
  const faultAtMs = record?.atMs ?? endMs;
  const recovery =
    sampling === null || record === null
      ? null
      : faultRecovery(sampling, options, {
          faultAtMs,
          interrupted: record.inRound,
          terminated,
        });
  const replacement = recovery?.replacement ?? null;
  const claims = (timeline?.claims ?? []).filter((claim) => claim.atMs >= faultAtMs);
  const attributed = attributeFaultClaims(claims, faultAtMs, record?.inFlightEndedMs ?? null);
  // The latest possible next regular slot: the start of the interrupted round plus I, or the
  // fault plus I without one.
  const nextRound = latestNextSlot({
    faultAtMs,
    interruptedStartMs: record?.roundStartMs ?? null,
    heartbeatMs: run.heartbeatMs,
  });
  // The attempts of the observation: their claims, their settlements, their last samples, and the
  // attempts that were live and unexpired in the last sample.
  const attemptRecords: AttemptRecords = {
    claimed: (timeline?.claims ?? []).map((claim) => ({
      attempt: claim.attempt,
      atMs: claim.atMs,
    })),
    closed: (timeline?.closes ?? []).map((close) => ({
      attempt: close.attempt,
      outcome: close.outcome,
      finishedAtMs: close.atMs,
    })),
    lastSamples: [...driverSampling.attempts].map(([attempt, sample]) => ({
      attempt,
      renewalMs: sample.renewalMs - started,
      deadlineMs: sample.deadlineMs - started,
    })),
    liveAtEnd: driverSampling.liveAtEnd,
    observedUntilMs: driverSampling.lastAttemptSampleMs ?? -Infinity,
  };
  const watchdog = watchdogVerdict(attemptRecords, faultAtMs);
  const replacementRoundMs = replacement?.firstRoundMs ?? endMs;
  const firstClaimAfterRoundMs = claims.find((claim) => claim.atMs > replacementRoundMs)?.atMs;
  // The roles from the first round on the replacement to the end of the observation.
  const afterRecovery =
    replacement === null || roles === null
      ? []
      : roles.series.rows.filter((row) => row[0]! >= replacementRoundMs);
  const maxColumn = (column: number) =>
    afterRecovery.length === 0 ? null : Math.max(...afterRecovery.map((row) => row[column]!));
  return {
    armedMs: record?.armedMs ?? null,
    atMs: record === null ? null : round(faultAtMs),
    searchTimedOut: record?.searchTimedOut ?? null,
    inRound: record?.inRound ?? null,
    roleBackends: record?.roleBackends ?? [],
    roleBackendsEndedMs: record?.roleBackendsEndedMs ?? null,
    inFlight: record?.inFlight ?? [],
    inFlightEndedMs: round(record?.inFlightEndedMs ?? null),
    error: record?.error ?? null,
    replacement,
    lastRoundBeforeFaultMs: round(recovery?.lastRoundBeforeFaultMs ?? null),
    nextRound,
    watchdog,
    // The claims after the fault by origin: from a statement that started before the fault,
    // unattributed, or fresh.
    claimsFromStatementsBeforeFault: attributed.beforeFault,
    unattributedClaimsMs: attributed.uncertain.map((atMs) => round(atMs)!),
    freshClaimsMs: attributed.fresh.map((atMs) => round(atMs)!),
    firstClaimAfterReplacementRoundMs:
      replacement === null || firstClaimAfterRoundMs === undefined
        ? null
        : round(firstClaimAfterRoundMs - replacementRoundMs),
    // Each recovered attempt with its `finished_at` and the deadline of its last sample.
    recoveries: attemptRecords.closed
      .filter((close) => close.outcome === "lease_expired")
      .map((close) => ({
        attempt: close.attempt,
        finishedAtMs: round(close.finishedAtMs),
        deadlineMs: round(
          attemptRecords.lastSamples.find((entry) => entry.attempt === close.attempt)?.deadlineMs ??
            null,
        ),
      })),
    demand: (replay?.demand ?? []).map((entry) => ({
      fromMs: round(entry.fromMs),
      toMs: round(entry.toMs),
    })),
    facts: {
      terminated: terminated.length,
      faultAtMs,
      claims,
      inFlightEndedMs: record?.inFlightEndedMs ?? null,
      readyNotBeforeMs: replacement?.readyNotBeforeMs ?? null,
      replacementRoundMs: replacement?.firstRoundMs ?? null,
      observationEndMs: endMs,
      nextRound,
      demand: replay?.demand ?? [],
      attempts: attemptRecords,
      maxListenerAfterRecovery: maxColumn(1),
      maxHeartbeatAfterRecovery: maxColumn(2),
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
  // A held-task cell needs one task for each slot and some spare tasks. A refill or a fault cell
  // gives each slot many tasks, so each slot claims again many times.
  const enqueued = run.tasksPerSlot === null ? expected + spare : expected * run.tasksPerSlot;
  const applicationName = `wh-bench-${sdk}`;
  const guardWait = await waitForQuietMachine();
  const machineBefore = machineState();
  // A probe from an earlier cell or run must not share this cell.
  const strayBefore = await endProbeSessions(pools.final, 0);
  await resetSchema(pools.admin);
  await enqueueTasks(pools.admin, run, enqueued);

  console.error(`${sdk} ${run.id}: start (${run.kind}, ${expected} slots, ${enqueued} tasks)`);
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
    attempts: new Map(),
    liveAtEnd: [],
    lastAttemptSampleMs: null,
    measuredRenewalAgesMs: [],
    measuredLeaseMarginsMs: [],
    sampleErrors: 0,
    sampleErrorMessages: [],
  };
  let probeExitedEarlyMs: number | null = null;
  // Why the sampling ended: the window closed, no task remained, the observation after the fault
  // ended, or the probe exited.
  let endReason: "window" | "drained" | "fault-observed" | "probe-exited" = "window";
  let drainedSinceMs: number | null = null;
  const fault: { injecting: Promise<FaultRecord> | null; record: FaultRecord | null } = {
    injecting: null,
    record: null,
  };
  let timeline: Awaited<ReturnType<typeof claimTimeline>> | null = null;
  let completion: Awaited<ReturnType<typeof completionCounts>> | null = null;
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
      if (run.kind === "fault") {
        // The fault runs in parallel, so the samples go on while it looks for a heartbeat round.
        if (fault.injecting === null && elapsedMs >= run.warmupMs) {
          fault.injecting = injectFault(applicationName, run, started, roleSampler, pools.final);
          void fault.injecting.then((record) => {
            fault.record = record;
          });
        }
        if (fault.record !== null && elapsedMs >= fault.record.atMs + run.faultObserveMs!) {
          endReason = "fault-observed";
          break;
        }
      }
      try {
        const { sample, ages, margins, attempts } = await takeSample(
          pools.sample,
          applicationName,
          elapsedMs,
          probe.poolSamples.at(-1) ?? null,
        );
        sampling.samples.push(sample);
        for (const [key, value] of attempts) sampling.attempts.set(key, value);
        sampling.liveAtEnd = attempts
          .filter(([, value]) => value.deadlineMs > value.sampledMs)
          .map(([key]) => key);
        sampling.lastAttemptSampleMs = elapsedMs;
        if (elapsedMs >= run.warmupMs) {
          sampling.measuredRenewalAgesMs.push(...ages);
          sampling.measuredLeaseMarginsMs.push(...margins);
        }
        // A refill cell ends when no task has been ready or active for one second.
        if (run.kind === "refill") {
          if (sample.readyTasks !== 0 || sample.activeTasks !== 0) drainedSinceMs = null;
          else drainedSinceMs ??= elapsedMs;
          if (drainedSinceMs !== null && elapsedMs - drainedSinceMs >= 1_000) {
            endReason = "drained";
            break;
          }
        }
      } catch (error) {
        sampling.sampleErrors += 1;
        if (sampling.sampleErrorMessages.length < 5) {
          sampling.sampleErrorMessages.push(String(error));
        }
      }
      // A probe that exited holds nothing more. Two seconds of samples show its connections close.
      if (probeExitedEarlyMs !== null && elapsedMs - probeExitedEarlyMs > 2_000) {
        endReason = "probe-exited";
        break;
      }
    }
    if (fault.injecting !== null) fault.record = await fault.injecting;
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
    if (run.kind !== "held") {
      try {
        timeline = await claimTimeline(pools.final, started, run.leaseMs);
      } catch (error) {
        finalErrors.push(`claim timeline: ${String(error)}`);
      }
    }
    if (run.kind === "refill") {
      try {
        completion = await completionCounts(pools.final);
      } catch (error) {
        finalErrors.push(`completion counts: ${String(error)}`);
      }
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
  const roleOptions = {
    windowStartMs: run.warmupMs,
    samplerEndMs: roleSamplerEndMs,
    heartbeatMs: run.heartbeatMs,
    commitInference,
  };
  const roles = roleSampling === null ? null : connectionRoles(roleSampling, roleOptions);
  const readyIntervals =
    roleSampling === null ? [] : heartbeatReadyIntervals(roleSampling, roleOptions);
  const replay =
    run.kind === "held"
      ? null
      : dispatchReplay(run, enqueued, roleSamplerEndMs, timeline, readyIntervals);
  const refillOutcome = refillResult(run, enqueued, timeline, completion, replay, readyIntervals);
  const faultOutcome = faultResult(
    run,
    started,
    roleSamplerEndMs,
    fault.record,
    timeline,
    roleSampling,
    sampling,
    roleOptions,
    roles,
    replay,
  );
  const cellSeconds = roleSamplerEndMs / 1000;
  const outcome = {
    expectedSlots: expected,
    enqueuedTasks: enqueued,
    endReason,
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
    refill: refillOutcome,
    fault: faultOutcome,
    strayProbeSessionsBefore: strayBefore,
    leftoverProbeSessionsAfter: leftoverSessions,
    probe: {
      exitedBeforeStopMs: probeExitedEarlyMs,
      exitCode: probeRun.exitCode,
      signal: probeRun.signal,
      shutdownGraceMs,
      killDeadlineMs: probeRun.killDeadlineMs,
      killedAtDeadline: probeRun.killed,
      stopMs: probeRun.stopMs,
      workerErrors: probeRun.workerErrors,
      errorsAfterStop: probeRun.errorsAfterStop,
      started: probeRun.started,
      poolSamples: probe.poolSamples.length,
      waitedAcquires: probe.poolSamples.at(-1)?.waitedAcquires ?? null,
      events: probeRun.events,
      stdoutTail: probeRun.stdoutTail,
      stderrTail: probeRun.stderrTail,
    },
  };
  const heartbeatRole = roles?.observedHeartbeatRoleConnections;
  const facts: CellFacts = {
    kind: run.kind,
    heartbeatMs: run.heartbeatMs,
    leaseMs: run.leaseMs,
    slots: expected,
    finalUnexpiredActiveTasks: outcome.finalUnexpiredActiveTasks,
    lostLeases: outcome.lostLeases,
    maxExpiredActiveTasks: outcome.maxExpiredActiveTasks,
    maxRenewalAgeMs: outcome.renewalAgeMs.max,
    minLeaseMarginMs: outcome.minLeaseMarginMs,
    maxListenerConnections: roles?.listenerConnections.max ?? null,
    maxHeartbeatConnections:
      heartbeatRole === undefined
        ? null
        : typeof heartbeatRole === "string"
          ? "unknown"
          : heartbeatRole.max,
    workerErrors: probeRun.workerErrors,
    // Every failed or timed-out query of the driver: samples, final reads, the role sampler, and
    // the fault.
    sampleErrors:
      sampling.sampleErrors +
      finalErrors.length +
      (roleSamplerError === null ? 0 : 1) +
      (roles?.errors.length ?? 0) +
      (fault.record?.error ? 1 : 0),
    probe: {
      exitedBeforeStopMs: probeExitedEarlyMs,
      exitCode: probeRun.exitCode,
      killed: probeRun.killed,
      stopMs: probeRun.stopMs,
      killDeadlineMs: probeRun.killDeadlineMs,
      errorsAfterStop: probeRun.errorsAfterStop,
    },
    ...(refillOutcome === null
      ? {}
      : {
          refill: {
            tasks: refillOutcome.tasks,
            completedOnce: refillOutcome.completedOnce,
            remainingActive: refillOutcome.remainingActive,
            remainingReady: refillOutcome.remainingReady,
            pollMs: nullableNumber(probeRun.started?.["pollMs"]),
            certainGapMs: refillOutcome.certainGap.lengthMs,
            possibleGapMs: refillOutcome.possibleGap.lengthMs,
          },
        }),
    ...(faultOutcome === null ? {} : { fault: faultOutcome.facts }),
  };
  const result = cellResult(facts);
  const verdict =
    result.outcome === "pass"
      ? "PASS"
      : result.outcome === "fail"
        ? `FAIL (${result.failed.join(", ")})`
        : `INCONCLUSIVE (${result.inconclusive.join(", ")})`;
  console.error(`${sdk} ${run.id}: ${verdict}`);
  console.error(
    `${sdk} ${run.id}: unexpired ${outcome.finalUnexpiredActiveTasks}/${expected}, sessions ${outcome.maxConnections.total}, roles listen ${JSON.stringify(roles?.listenerConnections)} heartbeat-role ${JSON.stringify(roles?.observedHeartbeatRoleConnections)} peak ${roles?.peakHeartbeatBackendsInOneInterval} former ${JSON.stringify(roles?.formerHeartbeatConnections)} statement ${JSON.stringify(roles?.statementConnections)}, heartbeat starts ${roles?.heartbeatStarts} ends ${roles?.heartbeatEnds}, incomplete ${roles?.heartbeatObservationIncomplete}, sampler interval ${JSON.stringify(roles?.effectiveIntervalMs)} temp bytes ${roles?.maxRelationBytes}, pool idle max ${pool.idleCached.max} waiting max ${pool.waitingMax}, driver CPU ${outcome.measurementCost.driverCpuPercentOfOneCore}% sampler CPU ${outcome.measurementCost.roleSamplerBackendCpuPercentOfOneCore}%, lost leases ${outcome.lostLeases}, capacity failure ${outcome.initialCapacityFailure}, progress failure ${outcome.progressFailure}, exit ${probeRun.exitCode ?? probeRun.signal}`,
  );
  return {
    sdk,
    cell: run,
    result,
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

// --- Summary ---------------------------------------------------------------------------------

type CellRun = Awaited<ReturnType<typeof runCell>>;

const summaryColumns = [
  "sdk",
  "cell",
  "kind",
  "result",
  "failedRules",
  "tasks",
  "lostLeases",
  "expiredActiveTasks",
  "maxRenewalAgeMs",
  "minLeaseMarginMs",
  "claimGapMs",
  "outageClaims",
  "firstFreshClaimMs",
  "listeners",
  "heartbeatRole",
  "stopMs",
  "sigkill",
] as const;

/**
 * One row for each cell. `tasks` gives the live leases at the end of a held-task cell, and the
 * tasks that completed once of a refill cell. `expiredActiveTasks` is the most active tasks with an
 * expired lease in one sample: a lease can expire while no worker records its loss. `claimGapMs`
 * gives the longest gap with the reservation ready, then with its state unknown. `outageClaims`
 * gives the fresh and the unattributed claims before the first round on the replacement.
 */
function summaryRow(run: CellRun): (string | number | null)[] {
  const { outcome, result } = run;
  const roles = outcome.connectionRoles;
  const heartbeat = roles?.observedHeartbeatRoleConnections;
  const fault = outcome.fault;
  const roundMs = fault?.replacement?.firstRoundMs ?? Number.POSITIVE_INFINITY;
  const outageFresh = fault?.freshClaimsMs.filter((atMs) => atMs! < roundMs).length ?? 0;
  const outageUnattributed =
    fault?.unattributedClaimsMs.filter((atMs) => atMs! < roundMs).length ?? 0;
  const tasks =
    run.cell.kind === "refill"
      ? `${outcome.refill?.completedOnce}/${outcome.refill?.tasks} once`
      : run.cell.kind === "held"
        ? `${outcome.finalUnexpiredActiveTasks}/${outcome.expectedSlots} live`
        : `${outcome.finalClaimEvents} claims`;
  const row: Record<(typeof summaryColumns)[number], string | number | null> = {
    sdk: run.sdk,
    cell: run.cell.id,
    kind: run.cell.kind,
    result: result.outcome === "fail" ? "FAIL" : result.outcome,
    // A rule that the observations could not decide ends with "?".
    failedRules:
      [...result.failed, ...result.inconclusive.map((rule) => `${rule}?`)].join("; ") || "-",
    tasks,
    lostLeases: outcome.lostLeases,
    expiredActiveTasks: outcome.maxExpiredActiveTasks,
    maxRenewalAgeMs: outcome.renewalAgeMs.max,
    minLeaseMarginMs: outcome.minLeaseMarginMs,
    claimGapMs:
      outcome.refill === null
        ? null
        : `${outcome.refill.certainGap.lengthMs}/${outcome.refill.possibleGap.lengthMs}`,
    outageClaims: fault === null ? null : `${outageFresh}/${outageUnattributed}`,
    firstFreshClaimMs:
      fault === null || fault.atMs === null || fault.freshClaimsMs[0] === undefined
        ? null
        : round(fault.freshClaimsMs[0]! - fault.atMs),
    listeners: roles?.listenerConnections.max ?? null,
    heartbeatRole:
      heartbeat === undefined ? null : typeof heartbeat === "string" ? heartbeat : heartbeat.max,
    stopMs: outcome.probe.stopMs,
    sigkill: outcome.probe.killedAtDeadline ? "yes" : "no",
  };
  return summaryColumns.map((column) => row[column]);
}

/** The summary as a plain-text table for the terminal. */
function summaryText(rows: readonly (string | number | null)[][]): string {
  const cells = [summaryColumns as readonly string[], ...rows].map((row) =>
    row.map((value) => (value === null ? "-" : String(value))),
  );
  const widths = summaryColumns.map((_, column) =>
    Math.max(...cells.map((row) => row[column]!.length)),
  );
  return cells
    .map((row) => row.map((value, column) => value.padEnd(widths[column]!)).join("  "))
    .join("\n");
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
  const summaryRows = runs.map(summaryRow);
  console.error(summaryText(summaryRows));
  const report = {
    benchmark: "connection-budget",
    schemaVersion: 4,
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
      shutdownGraceMs,
      killMarginMs,
      // The unwind window of each SDK, its source, and the kill deadline that follows from it.
      shutdown: Object.fromEntries(
        sdks.map((sdk) => [
          sdk,
          { ...sdkVariants[sdk]!.unwind, killDeadlineMs: killDeadlineMs(sdk) },
        ]),
      ),
      progressFailureMs,
      refillClaimGapLimitMs,
      faultWatchMs,
      dispatchAllowanceMs,
      roleSampleIntervalMs,
      roleChunkMs,
      commitInference,
      guard,
      sdks,
      matrix: cells,
    },
    wallTimeMs: Date.now() - started,
    summary: { columns: summaryColumns, rows: summaryRows },
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
