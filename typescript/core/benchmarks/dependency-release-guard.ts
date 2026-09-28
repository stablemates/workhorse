import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import type { Pool, PoolClient } from "pg";
import { installSchema } from "../src/schema.js";
import {
  summarizeLatencies,
  summarizeNumbers,
  type LatencySummary,
  type NumericSummary,
} from "./statistics.js";

/**
 * Measures what the exact-zero guard costs `resolve_dependents_many_v1` (SM-937). Before a
 * dependent settles because its counter reaches zero, the guard probes the pending-edge index for
 * an edge the counter missed. A healthy release always takes that probe and never finds an edge.
 *
 * The control is a copy of the resolver without the probe, installed beside it for the run and
 * dropped afterwards. Both functions resolve the same prerequisite inside a transaction that rolls
 * back, so every call does the same work. The two series alternate call by call, and each round
 * records the host load average, because the host runs other work that one run cannot separate.
 */

export interface DependencyReleaseGuardOptions {
  /** Alternating rounds per shape. */
  rounds?: number;
  /** Measured calls per series per round. */
  samplesPerRound?: number;
  /** Unmeasured calls per series before the first round of each shape. */
  warmupSamples?: number;
  /** Install the schema into a fresh `workhorse` schema before loading. */
  install?: boolean;
}

interface ResolvedOptions {
  rounds: number;
  samplesPerRound: number;
  warmupSamples: number;
  install: boolean;
}

const defaults: ResolvedOptions = {
  rounds: 5,
  samplesPerRound: 100,
  warmupSamples: 10,
  install: true,
};

const guardSeries = ["guarded", "unguarded"] as const;
type Series = (typeof guardSeries)[number];

const functionName: Record<Series, string> = {
  guarded: "workhorse.resolve_dependents_many_v1",
  unguarded: "workhorse.resolve_dependents_many_unguarded_bench",
};

/**
 * `single` releases one dependent of one prerequisite. `fan-out` releases the largest number of
 * dependents one prerequisite may have. `fan-in` resolves the last of the largest number of
 * prerequisites one dependent may have, after the others resolved and a vacuum ran.
 */
const guardShapes = ["single", "fan-out", "fan-in"] as const;
type Shape = (typeof guardShapes)[number];

const maxEdges = 100;
const queueName = "dependency-release-guard";

interface RoundResult {
  round: number;
  /** `os.loadavg()` one-minute value when the round started and when it ended. */
  loadAverage1m: { start: number; end: number };
  meanMs: Record<Series, number>;
  /** Mean call time of the guarded resolver divided by that of the control in the same round. */
  guardedOverUnguarded: number;
}

interface ShapeResult {
  shape: Shape;
  /** Dependents each call releases. */
  releasedPerCall: number;
  latency: Record<Series, NumericSummary & LatencySummary>;
  rounds: RoundResult[];
  guardedOverUnguarded: NumericSummary;
}

export interface DependencyReleaseGuardReport {
  schemaVersion: number;
  serverVersion: string;
  options: ResolvedOptions;
  results: ShapeResult[];
}

function resolveOptions(options: DependencyReleaseGuardOptions = {}): ResolvedOptions {
  const resolved: ResolvedOptions = {
    ...defaults,
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  };
  for (const name of ["rounds", "samplesPerRound"] as const) {
    const value = resolved[name];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (!Number.isSafeInteger(resolved.warmupSamples) || resolved.warmupSamples < 0) {
    throw new RangeError("warmupSamples must be an integer of at least 0");
  }
  return resolved;
}

export async function runDependencyReleaseGuardBenchmark(
  pool: Pool,
  options: DependencyReleaseGuardOptions = {},
): Promise<DependencyReleaseGuardReport> {
  const resolved = resolveOptions(options);
  if (resolved.install) {
    await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
    await installSchema(pool);
  }
  await installControl(pool);
  try {
    await pool.query("DELETE FROM workhorse.task WHERE queue_name = $1", [queueName]);
    const results: ShapeResult[] = [];
    for (const shape of guardShapes) {
      const fixture = await loadShape(pool, shape);
      results.push(await measureShape(pool, resolved, shape, fixture));
    }
    const schemaVersion = Number(
      (
        await pool.query<{ version: string }>(
          "SELECT max(version) AS version FROM workhorse.schema_version",
        )
      ).rows[0]!.version,
    );
    const serverVersion = (await pool.query<{ server_version: string }>("SHOW server_version"))
      .rows[0]!.server_version;
    return { schemaVersion, serverVersion, options: resolved, results };
  } finally {
    await pool.query(`DROP FUNCTION IF EXISTS ${functionName.unguarded}(uuid[], text[])`);
  }
}

/** Copies the installed resolver under another name with the pending-edge probe removed. */
async function installControl(pool: Pool): Promise<void> {
  const definition = (
    await pool.query<{ definition: string }>(
      `SELECT pg_get_functiondef('workhorse.resolve_dependents_many_v1(uuid[], text[])'::regprocedure)
         AS definition`,
    )
  ).rows[0]!.definition;
  const guard =
    /\s+OR \(\s*runtime\.pending_prerequisites = resolved\.decrement\s+AND EXISTS \(\s*SELECT 1 FROM workhorse\.task_dependency dependency\s+WHERE dependency\.dependent_task_id = runtime\.task_id\s+AND dependency\.released_at IS NULL\s*\)\s*\)(?= AS repaired)/;
  if (!guard.test(definition)) throw new Error("the installed resolver has no exact-zero guard");
  const control = definition
    .replace(guard, "")
    .replace(
      /FUNCTION workhorse\.resolve_dependents_many_v1\(/,
      `FUNCTION ${functionName.unguarded}(`,
    );
  await pool.query(control);
}

interface Fixture {
  /** The prerequisite every measured call resolves. */
  prerequisiteTaskId: string;
  releasedPerCall: number;
}

async function enqueue(pool: Pool, requests: object[]): Promise<string[]> {
  const result = await pool.query<{ task_id: string }>(
    "SELECT task_id FROM workhorse.enqueue_many_v1($1::jsonb)",
    [JSON.stringify(requests)],
  );
  return result.rows.map((row) => row.task_id);
}

function request(type: string, prerequisiteTaskIds: string[] = []): object {
  return {
    queue: queueName,
    type: `benchmark.${type}`,
    payload: {},
    maxAttempts: 3,
    retryPolicy: null,
    tags: [],
    ...(prerequisiteTaskIds.length === 0
      ? {}
      : {
          dependencies: {
            prerequisiteTaskIds,
            onSuccess: "release",
            onFailure: "fail",
            onCancellation: "cancel",
          },
        }),
  };
}

async function loadShape(pool: Pool, shape: Shape): Promise<Fixture> {
  if (shape === "single") {
    const [prerequisiteTaskId] = await enqueue(pool, [request("prerequisite")]);
    await enqueue(pool, [request("dependent", [prerequisiteTaskId!])]);
    await pool.query("VACUUM ANALYZE workhorse.task_dependency, workhorse.task_runtime");
    return { prerequisiteTaskId: prerequisiteTaskId!, releasedPerCall: 1 };
  }
  if (shape === "fan-out") {
    const [prerequisiteTaskId] = await enqueue(pool, [request("prerequisite")]);
    await enqueue(
      pool,
      Array.from({ length: maxEdges }, () => request("dependent", [prerequisiteTaskId!])),
    );
    await pool.query("VACUUM ANALYZE workhorse.task_dependency, workhorse.task_runtime");
    return { prerequisiteTaskId: prerequisiteTaskId!, releasedPerCall: maxEdges };
  }
  const prerequisites = await enqueue(
    pool,
    Array.from({ length: maxEdges }, () => request("prerequisite")),
  );
  await enqueue(pool, [request("dependent", prerequisites)]);
  // The resolver reads no prerequisite state, so the earlier edges resolve without running tasks.
  const earlier = prerequisites.slice(0, -1);
  await pool.query("SELECT workhorse.resolve_dependents_many_v1($1::uuid[], $2::text[])", [
    earlier,
    earlier.map(() => "succeeded"),
  ]);
  await pool.query("VACUUM ANALYZE workhorse.task_dependency, workhorse.task_runtime");
  return { prerequisiteTaskId: prerequisites.at(-1)!, releasedPerCall: 1 };
}

async function measureShape(
  pool: Pool,
  options: ResolvedOptions,
  shape: Shape,
  fixture: Fixture,
): Promise<ShapeResult> {
  const client = await pool.connect();
  const samples: Record<Series, number[]> = { guarded: [], unguarded: [] };
  const rounds: RoundResult[] = [];
  try {
    for (let sample = 0; sample < options.warmupSamples; sample += 1) {
      for (const series of guardSeries) await resolve(client, series, fixture);
    }
    for (let round = 1; round <= options.rounds; round += 1) {
      // Each rolled-back call leaves dead row versions, so every round starts from the same table.
      await client.query("VACUUM workhorse.task_dependency, workhorse.task_runtime");
      const start = loadavg()[0]!;
      const roundSamples: Record<Series, number[]> = { guarded: [], unguarded: [] };
      for (let sample = 0; sample < options.samplesPerRound; sample += 1) {
        // Reverse the order every other sample, so neither series always runs first.
        const order = sample % 2 === 0 ? guardSeries : guardSeries.toReversed();
        for (const series of order) {
          roundSamples[series].push(await resolve(client, series, fixture));
        }
      }
      const meanMs = {
        guarded: mean(roundSamples.guarded),
        unguarded: mean(roundSamples.unguarded),
      };
      samples.guarded.push(...roundSamples.guarded);
      samples.unguarded.push(...roundSamples.unguarded);
      rounds.push({
        round,
        loadAverage1m: { start, end: loadavg()[0]! },
        meanMs,
        guardedOverUnguarded: meanMs.guarded / meanMs.unguarded,
      });
    }
    return {
      shape,
      releasedPerCall: fixture.releasedPerCall,
      latency: {
        guarded: { ...summarizeNumbers(samples.guarded), ...summarizeLatencies(samples.guarded) },
        unguarded: {
          ...summarizeNumbers(samples.unguarded),
          ...summarizeLatencies(samples.unguarded),
        },
      },
      rounds,
      guardedOverUnguarded: summarizeNumbers(rounds.map((round) => round.guardedOverUnguarded)),
    };
  } finally {
    client.release();
  }
}

/** Resolves the fixture's prerequisite inside a transaction that rolls back. */
async function resolve(client: PoolClient, series: Series, fixture: Fixture): Promise<number> {
  await client.query("BEGIN");
  try {
    const started = performance.now();
    const result = await client.query<{ released: number }>(
      `SELECT ${functionName[series]}(ARRAY[$1]::uuid[], ARRAY['succeeded']) AS released`,
      [fixture.prerequisiteTaskId],
    );
    const elapsedMs = performance.now() - started;
    if (Number(result.rows[0]!.released) !== fixture.releasedPerCall) {
      throw new Error(`${series} released ${result.rows[0]!.released} dependents`);
    }
    return elapsedMs;
  } finally {
    await client.query("ROLLBACK");
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
