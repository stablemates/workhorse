import { performance } from "node:perf_hooks";
import type { Pool, PoolClient } from "pg";
import { Queue, installSchema } from "../src/index.js";
import type { ClaimedJob, Json, Queryable } from "../src/types.js";
import {
  ConventionalQueue,
  conventionalSchema,
  type ConventionalClaimedJob,
} from "./conventional.js";
import {
  summarizeLatencies,
  summarizeNumbers,
  type LatencySummary,
  type NumericSummary,
} from "./statistics.js";
import {
  captureActivitySnapshot,
  capturePgStatIoSnapshot,
  captureRelationTelemetry,
  captureSchemaTotals,
  captureWalLsnDifference,
  captureWalLsnStart,
  diffPgStatIoSnapshots,
  explainAnalyzeBuffersJson,
} from "./telemetry.js";

export type ComparativeDesign = "conventional" | "queue";
export type JsonSafe = null | boolean | number | string | JsonSafe[] | { [key: string]: JsonSafe };

export interface ChurnOptions {
  durationMs: number;
  batchSize: number;
  sampleIntervalMs: number;
  workerConcurrency: number;
}

export interface ComparativeBenchmarkOptions {
  jobsPerRun: number;
  repetitions: number;
  workerConcurrency: number[];
  queueName: string;
  leaseMs: number;
  churn: ChurnOptions;
}

export type ComparativeBenchmarkOptionsInput = Partial<
  Omit<ComparativeBenchmarkOptions, "churn">
> & {
  churn?: Partial<ChurnOptions>;
};

export const smokeSafeComparativeDefaults: Readonly<ComparativeBenchmarkOptions> = Object.freeze({
  jobsPerRun: 20,
  repetitions: 1,
  workerConcurrency: Object.freeze([1, 2]) as unknown as number[],
  queueName: "comparative-v2",
  leaseMs: 30_000,
  churn: Object.freeze({
    durationMs: 1_000,
    batchSize: 10,
    sampleIntervalMs: 250,
    workerConcurrency: 2,
  }),
});

export interface RunTelemetry {
  wal: JsonSafe;
  relationsBefore: JsonSafe;
  relationsAfter: JsonSafe;
  schemaBefore: JsonSafe;
  schemaAfter: JsonSafe;
  pgStatIoDelta: JsonSafe;
  activityBefore: JsonSafe;
  activityAfter: JsonSafe;
  claimExplain: JsonSafe;
}

export interface ComparativeRunResult {
  design: ComparativeDesign;
  repetition: number;
  workerConcurrency: number;
  jobs: number;
  enqueueDurationMs: number;
  processingDurationMs: number;
  totalDurationMs: number;
  throughputPerSecond: number;
  completedJobs: number;
  claimLatencySamplesMs: number[];
  claimLatencyMs: LatencySummary;
  telemetry: RunTelemetry;
}

export interface ChurnSample {
  elapsedMs: number;
  batches: number;
  enqueuedJobs: number;
  completedJobs: number;
  relations: JsonSafe;
  schema: JsonSafe;
  activity: JsonSafe;
}

export interface ChurnResult {
  design: ComparativeDesign;
  configuredDurationMs: number;
  actualDurationMs: number;
  batchSize: number;
  workerConcurrency: number;
  batches: number;
  enqueuedJobs: number;
  completedJobs: number;
  throughputPerSecond: number;
  claimLatencySamplesMs: number[];
  claimLatencyMs: LatencySummary;
  samples: ChurnSample[];
  telemetry: RunTelemetry;
}

export interface ComparativeGroupSummary {
  design: ComparativeDesign;
  workerConcurrency: number;
  repetitions: number;
  throughputPerSecond: NumericSummary;
  enqueueDurationMs: NumericSummary;
  processingDurationMs: NumericSummary;
  totalDurationMs: NumericSummary;
  walBytes: NumericSummary;
  completedJobs: NumericSummary;
  claimLatencyMs: LatencySummary & {
    samples: NumericSummary;
    perRunP95: NumericSummary;
  };
}

export interface ComparativeBenchmarkResult {
  version: 2;
  options: ComparativeBenchmarkOptions;
  runs: ComparativeRunResult[];
  summaries: ComparativeGroupSummary[];
  churn: ChurnResult[];
}

interface QueueAdapter {
  design: ComparativeDesign;
  schema: string;
  enqueue(payload: Json): Promise<string>;
  claim(workerId: string): Promise<unknown | null>;
  complete(job: unknown, workerId: string): Promise<boolean>;
  claimSql: string;
}

interface WorkResult {
  completedJobs: number;
  claimLatencySamplesMs: number[];
}

const resetLockKey = 7_349_221_042;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function sortedCopy<T>(values: readonly T[], compare: (left: T, right: T) => number): T[] {
  const sorted: T[] = [];
  for (const value of values) {
    const insertionIndex = sorted.findIndex((entry) => compare(value, entry) < 0);
    if (insertionIndex === -1) sorted.push(value);
    else sorted.splice(insertionIndex, 0, value);
  }
  return sorted;
}

export function normalizeComparativeOptions(
  input: ComparativeBenchmarkOptionsInput = {},
  defaults: ComparativeBenchmarkOptions = smokeSafeComparativeDefaults,
): ComparativeBenchmarkOptions {
  const queueName = input.queueName ?? defaults.queueName;
  if (typeof queueName !== "string" || queueName.trim().length === 0) {
    throw new RangeError("queueName must not be empty.");
  }

  const concurrency = input.workerConcurrency ?? defaults.workerConcurrency;
  if (!Array.isArray(concurrency) || concurrency.length === 0) {
    throw new RangeError("workerConcurrency must contain at least one value.");
  }
  const workerConcurrency = sortedCopy(
    [...new Set(concurrency.map((value) => positiveInteger(value, "workerConcurrency")))],
    (left, right) => left - right,
  );

  const churnInput = input.churn ?? {};
  return {
    jobsPerRun: positiveInteger(input.jobsPerRun ?? defaults.jobsPerRun, "jobsPerRun"),
    repetitions: positiveInteger(input.repetitions ?? defaults.repetitions, "repetitions"),
    workerConcurrency,
    queueName: queueName.trim(),
    leaseMs: positiveInteger(input.leaseMs ?? defaults.leaseMs, "leaseMs"),
    churn: {
      durationMs: nonNegativeInteger(
        churnInput.durationMs ?? defaults.churn.durationMs,
        "churn.durationMs",
      ),
      batchSize: positiveInteger(
        churnInput.batchSize ?? defaults.churn.batchSize,
        "churn.batchSize",
      ),
      sampleIntervalMs: positiveInteger(
        churnInput.sampleIntervalMs ?? defaults.churn.sampleIntervalMs,
        "churn.sampleIntervalMs",
      ),
      workerConcurrency: positiveInteger(
        churnInput.workerConcurrency ?? defaults.churn.workerConcurrency,
        "churn.workerConcurrency",
      ),
    },
  };
}

export function toJsonSafe(value: unknown): JsonSafe {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === "object") {
    const entries = sortedCopy(
      Object.entries(value as Record<string, unknown>),
      ([left], [right]) => left.localeCompare(right),
    );
    return Object.fromEntries(entries.map(([key, entry]) => [key, toJsonSafe(entry)]));
  }
  return value === undefined ? null : String(value);
}

function walBytes(run: ComparativeRunResult): number {
  const wal = run.telemetry.wal;
  if (typeof wal !== "object" || wal === null || Array.isArray(wal)) return 0;
  const bytes = wal.bytes;
  return typeof bytes === "number" ? bytes : Number(bytes ?? 0);
}

export function summarizeComparativeRuns(
  runs: readonly ComparativeRunResult[],
): ComparativeGroupSummary[] {
  const groups = new Map<string, ComparativeRunResult[]>();
  for (const run of runs) {
    const key = `${run.design}:${run.workerConcurrency}`;
    const group = groups.get(key);
    if (group) group.push(run);
    else groups.set(key, [run]);
  }

  return sortedCopy(
    [...groups.values()].map((group) => {
      const first = group[0]!;
      const claimSamples = group.flatMap((run) => run.claimLatencySamplesMs);
      return {
        design: first.design,
        workerConcurrency: first.workerConcurrency,
        repetitions: group.length,
        throughputPerSecond: summarizeNumbers(group.map((run) => run.throughputPerSecond)),
        enqueueDurationMs: summarizeNumbers(group.map((run) => run.enqueueDurationMs)),
        processingDurationMs: summarizeNumbers(group.map((run) => run.processingDurationMs)),
        totalDurationMs: summarizeNumbers(group.map((run) => run.totalDurationMs)),
        walBytes: summarizeNumbers(group.map(walBytes)),
        completedJobs: summarizeNumbers(group.map((run) => run.completedJobs)),
        claimLatencyMs: {
          ...summarizeLatencies(claimSamples),
          samples: summarizeNumbers(claimSamples),
          perRunP95: summarizeNumbers(
            group.flatMap((run) =>
              run.claimLatencyMs.p95 === null ? [] : [run.claimLatencyMs.p95],
            ),
          ),
        },
      };
    }),
    (left, right) =>
      left.design.localeCompare(right.design) || left.workerConcurrency - right.workerConcurrency,
  );
}

async function resetSchemasInTransaction(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [resetLockKey]);
    await client.query(`SELECT ${conventionalSchema}.reset_v1()`);
    await client.query(`
      TRUNCATE ironshift.job,
               ironshift.job_event,
               ironshift.attempt_history
        RESTART IDENTITY CASCADE
    `);
    await client.query("ALTER SEQUENCE ironshift.fence_token_seq RESTART WITH 1");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function setupComparativeSchemas(pool: Pool): Promise<void> {
  const conventional = new ConventionalQueue(pool);
  await installSchema(pool);
  await conventional.setup();
  await resetComparativeSchemas(pool);
}

export async function resetComparativeSchemas(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await resetSchemasInTransaction(client);
  } finally {
    client.release();
  }
}

function createAdapters(pool: Pool, options: ComparativeBenchmarkOptions): QueueAdapter[] {
  const conventional = new ConventionalQueue(pool, options.queueName);
  const queue = new Queue(pool, options.queueName);
  return [
    {
      design: "conventional",
      schema: conventionalSchema,
      enqueue: (payload) => conventional.enqueue("comparative", payload),
      claim: (workerId) => conventional.claim(workerId, { leaseMs: options.leaseMs }),
      complete: (job, workerId) =>
        conventional.complete(job as ConventionalClaimedJob<unknown>, workerId, { ok: true }),
      claimSql: `SELECT * FROM ${conventionalSchema}.claim_v1($1, $2, $3)`,
    },
    {
      design: "queue",
      schema: "ironshift",
      enqueue: (payload) => queue.enqueue("comparative", payload),
      claim: (workerId) => queue.claim(workerId, { leaseMs: options.leaseMs }),
      complete: (job, workerId) =>
        queue.complete(job as ClaimedJob<unknown>, workerId, { ok: true }),
      claimSql: "SELECT * FROM ironshift.claim_v1($1, $2, $3)",
    },
  ];
}

async function enqueueJobs(adapter: QueueAdapter, count: number, batch: number): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, (_, index) => adapter.enqueue({ batch, sequence: index + 1 })),
  );
}

async function runWorkers(
  adapter: QueueAdapter,
  concurrency: number,
  workerPrefix: string,
): Promise<WorkResult> {
  const claimLatencySamplesMs: number[] = [];
  let completedJobs = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async (_, workerIndex) => {
      const workerId = `${workerPrefix}-${workerIndex + 1}`;
      while (true) {
        const claimStarted = performance.now();
        const job = await adapter.claim(workerId);
        const claimDurationMs = performance.now() - claimStarted;
        if (job === null) return;
        claimLatencySamplesMs.push(claimDurationMs);
        const accepted = await adapter.complete(job, workerId);
        if (!accepted) throw new Error(`${adapter.design} rejected completion for ${workerId}`);
        completedJobs += 1;
      }
    }),
  );

  return { completedJobs, claimLatencySamplesMs };
}

async function captureClaimExplain(
  pool: Pool,
  adapter: QueueAdapter,
  queueName: string,
  leaseMs: number,
): Promise<JsonSafe> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const plan = await explainAnalyzeBuffersJson(client, adapter.claimSql, [
      queueName,
      `explain-${adapter.design}`,
      leaseMs,
    ]);
    await client.query("ROLLBACK");
    return toJsonSafe(plan);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function captureBefore(
  pool: Pool,
  adapter: QueueAdapter,
): Promise<{
  activity: unknown;
  io: Awaited<ReturnType<typeof capturePgStatIoSnapshot>>;
  relations: unknown;
  schema: unknown;
  wal: Awaited<ReturnType<typeof captureWalLsnStart>>;
}> {
  const [activity, io, relations, schema] = await Promise.all([
    captureActivitySnapshot(pool),
    capturePgStatIoSnapshot(pool),
    captureRelationTelemetry(pool, adapter.schema),
    captureSchemaTotals(pool, adapter.schema),
  ]);
  const wal = await captureWalLsnStart(pool);
  return { activity, io, relations, schema, wal };
}

async function captureAfter(
  pool: Pool,
  adapter: QueueAdapter,
  before: Awaited<ReturnType<typeof captureBefore>>,
  claimExplain: JsonSafe,
): Promise<RunTelemetry> {
  const wal = await captureWalLsnDifference(pool, before.wal);
  const [activity, io, relations, schema] = await Promise.all([
    captureActivitySnapshot(pool),
    capturePgStatIoSnapshot(pool),
    captureRelationTelemetry(pool, adapter.schema),
    captureSchemaTotals(pool, adapter.schema),
  ]);
  return {
    wal: toJsonSafe(wal),
    relationsBefore: toJsonSafe(before.relations),
    relationsAfter: toJsonSafe(relations),
    schemaBefore: toJsonSafe(before.schema),
    schemaAfter: toJsonSafe(schema),
    pgStatIoDelta: toJsonSafe(diffPgStatIoSnapshots(before.io, io)),
    activityBefore: toJsonSafe(before.activity),
    activityAfter: toJsonSafe(activity),
    claimExplain,
  };
}

async function prepareExplain(
  pool: Pool,
  adapter: QueueAdapter,
  options: ComparativeBenchmarkOptions,
): Promise<JsonSafe> {
  await resetComparativeSchemas(pool);
  await enqueueJobs(adapter, Math.max(options.jobsPerRun, options.churn.batchSize), -1);
  const plan = await captureClaimExplain(pool, adapter, options.queueName, options.leaseMs);
  await resetComparativeSchemas(pool);
  return plan;
}

async function runOnce(
  pool: Pool,
  adapter: QueueAdapter,
  options: ComparativeBenchmarkOptions,
  repetition: number,
  workerConcurrency: number,
): Promise<ComparativeRunResult> {
  const claimExplain = await prepareExplain(pool, adapter, options);
  const before = await captureBefore(pool, adapter);
  const totalStarted = performance.now();
  const enqueueStarted = performance.now();
  await enqueueJobs(adapter, options.jobsPerRun, repetition);
  const enqueueDurationMs = performance.now() - enqueueStarted;
  const processingStarted = performance.now();
  const work = await runWorkers(
    adapter,
    workerConcurrency,
    `${adapter.design}-r${repetition}-c${workerConcurrency}`,
  );
  const processingDurationMs = performance.now() - processingStarted;
  const totalDurationMs = performance.now() - totalStarted;
  const telemetry = await captureAfter(pool, adapter, before, claimExplain);
  const claimLatencySamplesMs = sortedCopy(
    work.claimLatencySamplesMs,
    (left, right) => left - right,
  );

  return {
    design: adapter.design,
    repetition,
    workerConcurrency,
    jobs: options.jobsPerRun,
    enqueueDurationMs,
    processingDurationMs,
    totalDurationMs,
    throughputPerSecond: totalDurationMs === 0 ? 0 : (work.completedJobs / totalDurationMs) * 1_000,
    completedJobs: work.completedJobs,
    claimLatencySamplesMs,
    claimLatencyMs: summarizeLatencies(claimLatencySamplesMs),
    telemetry,
  };
}

async function captureChurnSample(
  pool: Pool,
  adapter: QueueAdapter,
  started: number,
  batches: number,
  enqueuedJobs: number,
  completedJobs: number,
): Promise<ChurnSample> {
  const [relations, schema, activity] = await Promise.all([
    captureRelationTelemetry(pool, adapter.schema),
    captureSchemaTotals(pool, adapter.schema),
    captureActivitySnapshot(pool),
  ]);
  return {
    elapsedMs: performance.now() - started,
    batches,
    enqueuedJobs,
    completedJobs,
    relations: toJsonSafe(relations),
    schema: toJsonSafe(schema),
    activity: toJsonSafe(activity),
  };
}

async function runChurn(
  pool: Pool,
  adapter: QueueAdapter,
  options: ComparativeBenchmarkOptions,
): Promise<ChurnResult> {
  const claimExplain = await prepareExplain(pool, adapter, options);
  const before = await captureBefore(pool, adapter);
  const started = performance.now();
  const deadline = started + options.churn.durationMs;
  let nextSampleAt = started + options.churn.sampleIntervalMs;
  let batches = 0;
  let enqueuedJobs = 0;
  let completedJobs = 0;
  const claimLatencySamplesMs: number[] = [];
  const samples: ChurnSample[] = [];

  while (performance.now() < deadline) {
    batches += 1;
    await enqueueJobs(adapter, options.churn.batchSize, batches);
    enqueuedJobs += options.churn.batchSize;
    const work = await runWorkers(
      adapter,
      options.churn.workerConcurrency,
      `${adapter.design}-churn-b${batches}`,
    );
    completedJobs += work.completedJobs;
    claimLatencySamplesMs.push(...work.claimLatencySamplesMs);
    if (performance.now() >= nextSampleAt) {
      samples.push(
        await captureChurnSample(pool, adapter, started, batches, enqueuedJobs, completedJobs),
      );
      nextSampleAt += options.churn.sampleIntervalMs;
    }
  }

  if (samples.length === 0 || samples.at(-1)!.batches !== batches) {
    samples.push(
      await captureChurnSample(pool, adapter, started, batches, enqueuedJobs, completedJobs),
    );
  }

  const actualDurationMs = performance.now() - started;
  const telemetry = await captureAfter(pool, adapter, before, claimExplain);
  const sortedClaimLatencySamplesMs = sortedCopy(
    claimLatencySamplesMs,
    (left, right) => left - right,
  );
  return {
    design: adapter.design,
    configuredDurationMs: options.churn.durationMs,
    actualDurationMs,
    batchSize: options.churn.batchSize,
    workerConcurrency: options.churn.workerConcurrency,
    batches,
    enqueuedJobs,
    completedJobs,
    throughputPerSecond: actualDurationMs === 0 ? 0 : (completedJobs / actualDurationMs) * 1_000,
    claimLatencySamplesMs: sortedClaimLatencySamplesMs,
    claimLatencyMs: summarizeLatencies(sortedClaimLatencySamplesMs),
    samples,
    telemetry,
  };
}

export async function runComparativeBenchmark(
  pool: Pool,
  input: ComparativeBenchmarkOptionsInput = {},
): Promise<ComparativeBenchmarkResult> {
  const options = normalizeComparativeOptions(input);
  await setupComparativeSchemas(pool);
  const adapters = createAdapters(pool, options);
  const runs: ComparativeRunResult[] = [];

  for (const workerConcurrency of options.workerConcurrency) {
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      for (const adapter of adapters) {
        runs.push(await runOnce(pool, adapter, options, repetition, workerConcurrency));
      }
    }
  }

  const churn: ChurnResult[] = [];
  for (const adapter of adapters) churn.push(await runChurn(pool, adapter, options));

  return {
    version: 2,
    options,
    runs,
    summaries: summarizeComparativeRuns(runs),
    churn,
  };
}

export function stringifyComparativeResult(result: ComparativeBenchmarkResult, space = 2): string {
  return JSON.stringify(toJsonSafe(result), null, space);
}

// Keep Queryable referenced in the public module so structural Pool-compatible callers remain obvious
// in generated declarations without widening the runner contract away from pg Pool.
export type ComparativeQueryable = Queryable;
