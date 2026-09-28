import { readFile } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import type { Pool, PoolClient } from "pg";
import { SCHEMA_MIGRATIONS, WORKHORSE_SCHEMA_VERSION } from "../src/schema.js";
import {
  applySchemaMigrationPlan,
  planSchemaContract,
  type SchemaMigrationPlan,
} from "../src/schema-migrations.js";
import { nearestRankPercentile, summarizeNumbers, type NumericSummary } from "./statistics.js";

/**
 * Compares the full-tier enqueue before and after migration 0027 made it set-based (SM-911).
 *
 * Version 26 inserts each request's rows as the request loop reaches it. Version 27 buffers the
 * rows and writes each table with one statement after the loop. Every arm is built the way an
 * operator reaches it: the frozen 0.4.0 release, then the migration chain up to the arm's version.
 * The arms alternate within one invocation, so drift in the host's load reaches all of them.
 *
 * A shared host makes a single timing untrustworthy, so every measured sample is paired with a
 * control: a plain multi-row `INSERT` of the same row count, timed on the same connection
 * straight after it. The ratio of the two is the figure that survives a change in host load.
 */

export interface SetBasedEnqueueOptions {
  /** Schema versions to compare. The first is the baseline every other arm is divided by. */
  versions?: readonly number[];
  /** Rounds. Each round rebuilds every arm once, in an order that reverses every round. */
  rounds?: number;
  /** Measured samples of each scenario per arm per round. */
  samples?: number;
  /** Unmeasured samples of each scenario before its measured ones. */
  warmupSamples?: number;
}

interface ResolvedOptions {
  versions: readonly number[];
  rounds: number;
  samples: number;
  warmupSamples: number;
}

const releaseVersion = 24;

const defaults: ResolvedOptions = {
  versions: [26, 27, WORKHORSE_SCHEMA_VERSION],
  rounds: 4,
  samples: 10,
  warmupSamples: 2,
};

interface Scenario {
  name: string;
  /** Tasks the scenario enqueues per sample. */
  tasks: number;
  /** Tasks per `enqueue_many_v1` call. */
  batchSize: number;
  /** Every task names one prerequisite, enqueued untimed before the sample. */
  dependents: boolean;
}

/** The four shapes SM-911 measured ad hoc. */
const scenarios: readonly Scenario[] = [
  { name: "100 tasks in batches of 25", tasks: 100, batchSize: 25, dependents: false },
  { name: "1,000 tasks in batches of 100", tasks: 1_000, batchSize: 100, dependents: false },
  { name: "1,000 tasks in one batch", tasks: 1_000, batchSize: 1_000, dependents: false },
  { name: "100 dependents in batches of 25", tasks: 100, batchSize: 25, dependents: true },
];

const queueName = "set-based-enqueue";

interface ScenarioSeries {
  /** Milliseconds to enqueue the scenario's tasks, summed over its calls. */
  enqueueMs: NumericSummary & { median: number | null };
  /** Milliseconds for the control insert of the same row count, straight after each sample. */
  controlMs: NumericSummary & { median: number | null };
  /** Each sample's enqueue time divided by its own control time. */
  enqueuePerControl: NumericSummary & { median: number | null };
  /**
   * This arm against the baseline arm; below 1 is faster. Both use medians, because a stall on a
   * shared host adds a sample many times the typical one and a mean follows it.
   */
  relativeToBaseline: {
    /** Median enqueue time divided by the baseline's. */
    elapsed: number | null;
    /** Median `enqueuePerControl` divided by the baseline's. */
    controlNormalized: number | null;
  };
}

interface ArmReport {
  schemaVersion: number;
  scenarios: Record<string, ScenarioSeries>;
}

interface RoundLoad {
  round: number;
  order: readonly number[];
  /** `os.loadavg()` when the round started and ended: the 1, 5 and 15 minute averages. */
  loadAverageStart: readonly number[];
  loadAverageEnd: readonly number[];
}

export interface SetBasedEnqueueReport {
  options: ResolvedOptions;
  postgresVersion: string;
  cpuCount: number;
  rounds: readonly RoundLoad[];
  arms: readonly ArmReport[];
}

interface Sample {
  enqueueMs: number;
  controlMs: number;
}

function resolveOptions(options: SetBasedEnqueueOptions = {}): ResolvedOptions {
  const resolved: ResolvedOptions = {
    ...defaults,
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  };
  for (const name of ["rounds", "samples"] as const) {
    if (!Number.isSafeInteger(resolved[name]) || resolved[name] < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (!Number.isSafeInteger(resolved.warmupSamples) || resolved.warmupSamples < 0) {
    throw new RangeError("warmupSamples must be an integer of at least 0");
  }
  if (resolved.versions.length === 0) throw new RangeError("versions must name at least one");
  for (const version of resolved.versions) {
    if (
      !Number.isSafeInteger(version) ||
      version <= releaseVersion ||
      version > WORKHORSE_SCHEMA_VERSION
    ) {
      throw new RangeError(
        `each version must lie after ${releaseVersion} and at most ${WORKHORSE_SCHEMA_VERSION}`,
      );
    }
  }
  return resolved;
}

export async function runSetBasedEnqueueBenchmark(
  pool: Pool,
  options: SetBasedEnqueueOptions = {},
): Promise<SetBasedEnqueueReport> {
  const resolved = resolveOptions(options);
  const samples = new Map<number, Map<string, Sample[]>>(
    resolved.versions.map((version) => [
      version,
      new Map(scenarios.map((scenario) => [scenario.name, []])),
    ]),
  );
  const rounds: RoundLoad[] = [];
  for (let round = 0; round < resolved.rounds; round += 1) {
    const order = round % 2 === 0 ? [...resolved.versions] : resolved.versions.toReversed();
    const loadAverageStart = loadavg();
    for (const version of order) {
      await buildArm(pool, version);
      const client = await pool.connect();
      try {
        for (const scenario of scenarios) {
          const series = samples.get(version)?.get(scenario.name);
          if (series === undefined) throw new Error(`no series for ${scenario.name}`);
          for (let sample = 0; sample < resolved.warmupSamples; sample += 1) {
            await measureSample(client, scenario);
          }
          for (let sample = 0; sample < resolved.samples; sample += 1) {
            series.push(await measureSample(client, scenario));
          }
        }
      } finally {
        client.release();
      }
    }
    rounds.push({ round: round + 1, order, loadAverageStart, loadAverageEnd: loadavg() });
  }

  const baseline = resolved.versions[0];
  const seriesOf = (version: number | undefined, scenario: string): readonly Sample[] =>
    version === undefined ? [] : (samples.get(version)?.get(scenario) ?? []);
  const arms = resolved.versions.map((version) => ({
    schemaVersion: version,
    scenarios: Object.fromEntries(
      scenarios.map((scenario) => {
        const own = seriesOf(version, scenario.name);
        const base = seriesOf(baseline, scenario.name);
        return [
          scenario.name,
          {
            enqueueMs: summarize(own.map((sample) => sample.enqueueMs)),
            controlMs: summarize(own.map((sample) => sample.controlMs)),
            enqueuePerControl: summarize(own.map(ratio)),
            relativeToBaseline: {
              elapsed: quotient(
                median(own.map((sample) => sample.enqueueMs)),
                median(base.map((sample) => sample.enqueueMs)),
              ),
              controlNormalized: quotient(median(own.map(ratio)), median(base.map(ratio))),
            },
          },
        ];
      }),
    ),
  }));
  const server = await pool.query<{ server_version: string }>("SHOW server_version");
  return {
    options: resolved,
    postgresVersion: server.rows[0]?.server_version ?? "unknown",
    cpuCount: availableParallelism(),
    rounds,
    arms,
  };
}

function quotient(numerator: number | null, denominator: number | null): number | null {
  return numerator === null || denominator === null || denominator === 0
    ? null
    : numerator / denominator;
}

function median(values: readonly number[]): number | null {
  return nearestRankPercentile(values, 0.5);
}

function summarize(values: readonly number[]): NumericSummary & { median: number | null } {
  return { ...summarizeNumbers(values), median: median(values) };
}

function ratio(sample: Sample): number {
  return sample.enqueueMs / sample.controlMs;
}

/**
 * Installs the 0.4.0 release and migrates it to `version`, applying the one contract step on the
 * way as an operator would after confirming it. The control table lives in the `workhorse` schema
 * so the next rebuild drops it too.
 */
async function buildArm(pool: Pool, version: number): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
  await pool.query(
    await readFile(sqlAsset(`releases/${String(releaseVersion).padStart(4, "0")}.sql`), "utf8"),
  );
  const plan: SchemaMigrationPlan = {
    baselineVersion: releaseVersion,
    currentVersion: version,
    steps: SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version),
    readStep: async (file) => readFile(sqlAsset(`migrations/${file}`), "utf8"),
  };
  for (;;) {
    const { finishedVersion, contractStop } = await applySchemaMigrationPlan(pool, plan);
    if (contractStop === null) {
      if (finishedVersion !== version) {
        throw new Error(`migration finished at ${finishedVersion} instead of ${version}`);
      }
      break;
    }
    const outcome = await planSchemaContract(pool, plan, { confirmed: true });
    if (outcome.kind !== "applied") throw new Error(`expected ${contractStop.file} to apply`);
  }
  await pool.query(
    `CREATE TABLE workhorse.benchmark_control (
       id uuid PRIMARY KEY,
       queue_name text NOT NULL,
       task_type text NOT NULL,
       payload jsonb NOT NULL
     )`,
  );
  await pool.query("ANALYZE");
}

function sqlAsset(relativePath: string): URL {
  return new URL(`../../../sql/${relativePath}`, import.meta.url);
}

async function measureSample(client: PoolClient, scenario: Scenario): Promise<Sample> {
  let prerequisiteTaskId: string | null = null;
  if (scenario.dependents) {
    const prerequisite = await client.query<{ task_id: string }>(
      "SELECT task_id FROM workhorse.enqueue_many_v1($1::jsonb)",
      [JSON.stringify([request("prerequisite", 0, null)])],
    );
    prerequisiteTaskId = prerequisite.rows[0]?.task_id ?? null;
    if (prerequisiteTaskId === null) throw new Error("the prerequisite enqueue returned no task");
  }
  const batches: string[] = [];
  for (let offset = 0; offset < scenario.tasks; offset += scenario.batchSize) {
    const size = Math.min(scenario.batchSize, scenario.tasks - offset);
    batches.push(
      JSON.stringify(
        Array.from({ length: size }, (_, index) =>
          request("work", offset + index, prerequisiteTaskId),
        ),
      ),
    );
  }

  const enqueueStarted = performance.now();
  for (const batch of batches) {
    const result = await client.query("SELECT task_id FROM workhorse.enqueue_many_v1($1::jsonb)", [
      batch,
    ]);
    if (result.rowCount === 0) throw new Error("an enqueue batch returned no rows");
  }
  const enqueueMs = performance.now() - enqueueStarted;

  const controlStarted = performance.now();
  await client.query(
    `INSERT INTO workhorse.benchmark_control(id, queue_name, task_type, payload)
     SELECT gen_random_uuid(), $2, 'benchmark.work', jsonb_build_object('index', index)
       FROM generate_series(1, $1::integer) index`,
    [scenario.tasks, queueName],
  );
  const controlMs = performance.now() - controlStarted;
  return { enqueueMs, controlMs };
}

function request(type: string, index: number, prerequisiteTaskId: string | null): object {
  return {
    queue: queueName,
    type: `benchmark.${type}`,
    payload: { index },
    maxAttempts: 25,
    retryPolicy: null,
    tags: [],
    ...(prerequisiteTaskId === null ? {} : { prerequisiteTaskId }),
  };
}
