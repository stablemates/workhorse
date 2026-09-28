#!/usr/bin/env node
/**
 * Counts the deadlocks PostgreSQL resolves while Rust SDK workers drain one fast-tier queue, with
 * the fused claim before and after SM-934. Nothing in CI runs this benchmark.
 */
import { spawnSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseUrl,
} from "../typescript/core/src/local-database.js";
import { installSchema } from "../typescript/core/src/schema.js";

const help = `Workhorse fast claim deadlock benchmark

Runs the Rust workers in rust/tools/fast-claim-stress against a seeded fast-tier queue. Each run
installs a fresh schema, then installs either the fused claim from migration 0025 (control) or
the one from migration 0040 (fix). Runs alternate control, fix, fix, control, so load drift on the
host affects both variants alike. A run reports the deadlocks PostgreSQL resolved and the outcomes
the workers recorded. The SDK retries a deadlocked write, so only the server count shows them.

The deadlock needs a claim to meet another worker's fresh lease, so it depends on timing. A run
in which the control variant also resolves no deadlock shows nothing about the fix; change
--concurrency, --workers, or --heartbeat-ms and run again.

Usage:
  pnpm benchmark:fast-claim-deadlock -- [options]

Options:
  --pairs N         Control and fix pairs, in ABBA order (default: 3)
  --workers N       Worker instances in the binary (default: 8)
  --concurrency N   Handler slots per worker (default: 16)
  --seconds N       Duration of each run (default: 30)
  --heartbeat-ms N  Heartbeat interval of each worker (default: 100)
  --work-ms N       Upper bound of each handler's sleep (default: 20)
  --tasks N         Ready tasks seeded before each run (default: 450000)
  --output PATH     Also write the JSON report to PATH
  --help            Show this help`;

const queue = "benchmark-fast-claim-deadlock";
const taskType = "benchmark.work";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function integer(name: string, fallback: number): number {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be an integer`);
  return value;
}

/** The `fast_claim_v1` definition a migration file installs. */
async function fastClaimDefinition(migration: string): Promise<string> {
  const source = await readFile(join(root, "sql/migrations", migration), "utf8");
  const start = source.indexOf("CREATE OR REPLACE FUNCTION workhorse.fast_claim_v1(");
  const end = source.indexOf("$$;", start);
  if (start === -1 || end === -1) throw new Error(`${migration} defines no fast_claim_v1`);
  return source.slice(start, end + "$$;".length);
}

if (process.argv.includes("--help")) {
  console.log(help);
  process.exit(0);
}

const pairs = integer("--pairs", 3);
if (pairs < 1) throw new Error("--pairs must be at least 1");
const settings = {
  workers: integer("--workers", 8),
  concurrency: integer("--concurrency", 16),
  seconds: integer("--seconds", 30),
  heartbeatMs: integer("--heartbeat-ms", 100),
  workMs: integer("--work-ms", 20),
  tasks: integer("--tasks", 450_000),
};
const variants = {
  control: await fastClaimDefinition("0025-add-a-fast-task-tier.sql"),
  fix: await fastClaimDefinition("0040-release-a-fused-claim-lock-before-it-can-deadlock.sql"),
};

const databaseUrl = localDatabaseUrl("bench");
assertLocalDatabasePurpose(databaseUrl, "bench");
console.error(`Fast claim deadlock benchmark target: ${databaseName(databaseUrl)}`);

const build = spawnSync(
  "cargo",
  ["build", "--release", "--quiet", "-p", "workhorse-fast-claim-stress"],
  { cwd: root, stdio: "inherit" },
);
if (build.status !== 0) throw new Error("cargo build of workhorse-fast-claim-stress failed");
const binary = join(root, "target/release/workhorse-fast-claim-stress");

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

async function prepare(variant: keyof typeof variants): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
  await installSchema(pool);
  await pool.query(variants[variant]);
  await pool.query(
    `SELECT workhorse.set_queue_tier_v1($1, 'fast', 'fast-claim-deadlock', 'benchmark')`,
    [queue],
  );
  await pool.query(
    `WITH source AS (
       SELECT gen_random_uuid() AS id, (row % 3) AS priority
         FROM generate_series(1, $3::integer) row
     ), identity AS (
       INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts, priority)
       SELECT id, $1, $2, '{}'::jsonb, 3, priority FROM source RETURNING id
     )
     INSERT INTO workhorse.fast_task_runtime(
       task_id, queue_name, task_type, state, priority, run_at, sequence, payload,
       result_max_bytes, redact, max_attempts, enqueued_at
     )
     SELECT source.id, $1, $2, 'ready', source.priority, now() - interval '1 minute',
            nextval('workhorse.ready_sequence_seq'), '{}'::jsonb, 1048576, false, 3, now()
       FROM source JOIN identity ON identity.id = source.id`,
    [queue, taskType, settings.tasks],
  );
  await pool.query("VACUUM ANALYZE workhorse.task, workhorse.fast_task_runtime");
}

async function deadlocks(): Promise<number> {
  const result = await pool.query<{ deadlocks: string }>(
    "SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()",
  );
  return Number(result.rows[0]!.deadlocks);
}

async function run(variant: keyof typeof variants) {
  await prepare(variant);
  const before = await deadlocks();
  const loadStart = loadavg()[0]!;
  const workers = spawnSync(binary, {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      WORKERS: String(settings.workers),
      CONCURRENCY: String(settings.concurrency),
      SECONDS: String(settings.seconds),
      HEARTBEAT_MS: String(settings.heartbeatMs),
      WORK_MS: String(settings.workMs),
    },
  });
  if (workers.status !== 0) throw new Error(`workhorse-fast-claim-stress exited ${workers.status}`);
  // pg_stat_database reaches other sessions only after the backend reports its statistics.
  await new Promise((resolve) => {
    setTimeout(resolve, 1000);
  });
  const outcomes = await pool.query<{ count: string }>(
    "SELECT count(*) FROM workhorse.fast_task_outcome WHERE queue_name = $1",
    [queue],
  );
  const result = {
    variant,
    deadlocks: (await deadlocks()) - before,
    outcomes: Number(outcomes.rows[0]!.count),
    loadAverage1m: { start: loadStart, end: loadavg()[0]! },
  };
  console.error(JSON.stringify(result));
  return result;
}

try {
  const serverVersion = (await pool.query<{ server_version: string }>("SHOW server_version"))
    .rows[0]!.server_version;
  const deadlockTimeout = (await pool.query<{ deadlock_timeout: string }>("SHOW deadlock_timeout"))
    .rows[0]!.deadlock_timeout;
  const runs: Awaited<ReturnType<typeof run>>[] = [];
  for (let pair = 0; pair < pairs; pair += 1) {
    const order = pair % 2 === 0 ? (["control", "fix"] as const) : (["fix", "control"] as const);
    for (const variant of order) runs.push(await run(variant));
  }
  const summary = Object.fromEntries(
    (["control", "fix"] as const).map((variant) => {
      const own = runs.filter((entry) => entry.variant === variant);
      return [
        variant,
        {
          runs: own.length,
          deadlocks: own.reduce((sum, entry) => sum + entry.deadlocks, 0),
          meanOutcomes: Math.round(
            own.reduce((sum, entry) => sum + entry.outcomes, 0) / own.length,
          ),
        },
      ];
    }),
  );
  const report = {
    benchmark: "fast-claim-deadlock",
    recordedAt: new Date().toISOString(),
    serverVersion,
    deadlockTimeout,
    settings: { pairs, ...settings },
    summary,
    runs,
  };
  const output = argument("--output");
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.error(`Wrote ${output}`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
