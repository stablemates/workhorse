import { performance } from "node:perf_hooks";
import { platform } from "node:os";
import { execFileSync } from "node:child_process";
import type { Pool } from "pg";
import { summarizeNumbers, type NumericSummary } from "./statistics.js";
import {
  captureRelationTelemetry,
  captureSchemaTotals,
  captureWalLsnDifference,
  captureWalLsnStart,
} from "./telemetry.js";
import {
  createCompetitorTargets,
  type CompetitorTarget,
  type TargetMetadata,
  type WorkItem,
} from "./targets/index.js";

export type CompetitorTargetName = "ironshift" | "pg-boss" | "graphile-worker";
export type CompetitorProfileName = "smoke" | "default";
export interface CompetitorOptions {
  profile: CompetitorProfileName;
  seed: number;
  jobsPerRun: number;
  enqueueBatchSize: number;
  repetitions: number;
  workerConcurrency: number[];
  churnJobs: number;
  churnRatePerSecond: number;
  churnBatchSize: number;
  sampleIntervalMs: number;
  completionTimeoutMs: number;
}
export type CompetitorOptionsInput = Partial<CompetitorOptions>;
export const competitorProfiles: Readonly<Record<CompetitorProfileName, CompetitorOptions>> =
  Object.freeze({
    smoke: Object.freeze({
      profile: "smoke",
      seed: 1,
      jobsPerRun: 30,
      enqueueBatchSize: 10,
      repetitions: 3,
      workerConcurrency: Object.freeze([1, 2]) as unknown as number[],
      churnJobs: 60,
      churnRatePerSecond: 60,
      churnBatchSize: 10,
      sampleIntervalMs: 100,
      completionTimeoutMs: 30_000,
    }),
    default: Object.freeze({
      profile: "default",
      seed: 20260722,
      jobsPerRun: 3000,
      enqueueBatchSize: 100,
      repetitions: 6,
      workerConcurrency: Object.freeze([1, 4, 16]) as unknown as number[],
      churnJobs: 5000,
      churnRatePerSecond: 1000,
      churnBatchSize: 50,
      sampleIntervalMs: 250,
      completionTimeoutMs: 120_000,
    }),
  });
export interface ExecutionPlanStep {
  workerConcurrency: number;
  repetition: number;
  targetOrder: readonly CompetitorTargetName[];
}
export interface LoadSample {
  elapsedMs: number;
  enqueuedJobs: number;
  completedJobs: number;
  backlog: number;
}
export interface CompetitorRunResult {
  kind: "fixed-batch" | "equal-offered-load-churn";
  target: CompetitorTargetName;
  workerConcurrency: number;
  repetition: number;
  position: number;
  offeredJobs: number;
  enqueuedJobs: number;
  completedJobs: number;
  exactCompletion: boolean;
  phases: {
    enqueueMs: number;
    processingMs: number;
    totalMs: number;
    productionMs: number | null;
    drainMs: number | null;
  };
  rates: { enqueuePerSecond: number; processingPerSecond: number; totalPerSecond: number };
  load: { batches: number; maxBacklog: number; samples: LoadSample[] };
  telemetry: {
    walBytes: number;
    schemaBefore: unknown;
    schemaAfter: unknown;
    schemaGrowthBytes: number;
    relationsBefore: unknown[];
    relationsAfter: unknown[];
  };
}
export interface CompetitorSummary {
  target: CompetitorTargetName;
  kind: CompetitorRunResult["kind"];
  workerConcurrency: number;
  repetitions: number;
  processingPerSecond: NumericSummary;
  totalPerSecond: NumericSummary;
  enqueueMs: NumericSummary;
  processingMs: NumericSummary;
  totalMs: NumericSummary;
  walBytes: NumericSummary;
  schemaGrowthBytes: NumericSummary;
}
export interface CompetitorReport {
  artifactVersion: 1;
  generatedAt: Date;
  contract: "common-success-path-v1";
  semanticEquivalence: false;
  options: CompetitorOptions;
  provenance: {
    command: string;
    gitSha: string | null;
    node: string;
    platform: string;
    database: Record<string, unknown>;
  };
  targets: TargetMetadata[];
  executionPlan: ExecutionPlanStep[];
  runs: CompetitorRunResult[];
  summaries: CompetitorSummary[];
}

function positive(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive safe integer`);
}
export function normalizeCompetitorOptions(input: CompetitorOptionsInput = {}): CompetitorOptions {
  const profile = input.profile ?? "default";
  const base = competitorProfiles[profile];
  if (!base) throw new Error("profile must be smoke or default");
  const result = {
    ...base,
    ...input,
    profile,
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target does not include toSorted.
    workerConcurrency: [...new Set(input.workerConcurrency ?? base.workerConcurrency)].sort(
      (a, b) => a - b,
    ),
  };
  if (!Number.isSafeInteger(result.seed) || result.seed < 0)
    throw new Error("seed must be a non-negative safe integer");
  for (const key of [
    "jobsPerRun",
    "enqueueBatchSize",
    "repetitions",
    "churnJobs",
    "churnRatePerSecond",
    "churnBatchSize",
    "sampleIntervalMs",
    "completionTimeoutMs",
  ] as const)
    positive(key, result[key]);
  for (const value of result.workerConcurrency) positive("workerConcurrency", value);
  return result;
}
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
function shuffled<T>(values: readonly T[], next: () => number): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
export function createCompetitorExecutionPlan(
  workers: readonly number[],
  repetitions: number,
  seed: number,
): ExecutionPlanStep[] {
  const targets = ["ironshift", "pg-boss", "graphile-worker"] as const;
  const next = random(seed);
  const steps: ExecutionPlanStep[] = [];
  for (const workerConcurrency of workers) {
    const base = shuffled(targets, next);
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const offset = (repetition - 1) % 3;
      steps.push({
        workerConcurrency,
        repetition,
        targetOrder: [base[offset]!, base[(offset + 1) % 3]!, base[(offset + 2) % 3]!],
      });
    }
  }
  return shuffled(steps, next);
}
export function summarizeCompetitorRuns(runs: readonly CompetitorRunResult[]): CompetitorSummary[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target does not include toSorted.
  const keys = [...new Set(runs.map((r) => `${r.target}:${r.kind}:${r.workerConcurrency}`))].sort();
  return keys.map((key) => {
    const group = runs.filter((r) => `${r.target}:${r.kind}:${r.workerConcurrency}` === key);
    const first = group[0]!;
    return {
      target: first.target,
      kind: first.kind,
      workerConcurrency: first.workerConcurrency,
      repetitions: group.length,
      processingPerSecond: summarizeNumbers(group.map((r) => r.rates.processingPerSecond)),
      totalPerSecond: summarizeNumbers(group.map((r) => r.rates.totalPerSecond)),
      enqueueMs: summarizeNumbers(group.map((r) => r.phases.enqueueMs)),
      processingMs: summarizeNumbers(group.map((r) => r.phases.processingMs)),
      totalMs: summarizeNumbers(group.map((r) => r.phases.totalMs)),
      walBytes: summarizeNumbers(group.map((r) => r.telemetry.walBytes)),
      schemaGrowthBytes: summarizeNumbers(group.map((r) => r.telemetry.schemaGrowthBytes)),
    };
  });
}
export function stringifyCompetitorReport(report: CompetitorReport): string {
  return `${JSON.stringify(report, (_key, value) => (value instanceof Date ? value.toISOString() : typeof value === "bigint" ? value.toString() : value), 2)}\n`;
}
const now = () => performance.now();
const rate = (jobs: number, ms: number) => (ms <= 0 ? 0 : jobs / (ms / 1000));
async function telemetryStart(pool: Pool, target: CompetitorTarget) {
  return {
    wal: await captureWalLsnStart(pool),
    schema: await captureSchemaTotals(pool, target.metadata.schema),
    relations: await captureRelationTelemetry(pool, target.metadata.schema),
  };
}
async function telemetryEnd(
  pool: Pool,
  target: CompetitorTarget,
  before: Awaited<ReturnType<typeof telemetryStart>>,
) {
  const schema = await captureSchemaTotals(pool, target.metadata.schema);
  return {
    walBytes: (await captureWalLsnDifference(pool, before.wal)).bytes,
    schemaBefore: before.schema,
    schemaAfter: schema,
    schemaGrowthBytes: schema.totalBytes - before.schema.totalBytes,
    relationsBefore: before.relations,
    relationsAfter: await captureRelationTelemetry(pool, target.metadata.schema),
  };
}
function items(count: number, run: string, offset = 0): WorkItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${run}-${offset + index + 1}`,
    payload: { run, sequence: offset + index + 1 },
  }));
}
async function fixedRun(
  pool: Pool,
  target: CompetitorTarget,
  options: CompetitorOptions,
  step: ExecutionPlanStep,
  position: number,
): Promise<CompetitorRunResult> {
  await target.reset();
  await target.setup();
  const before = await telemetryStart(pool, target);
  const all = items(
    options.jobsPerRun,
    `${step.workerConcurrency}-${step.repetition}-${target.metadata.name}`,
  );
  const totalStart = now();
  const enqueueStart = now();
  let batches = 0;
  for (let i = 0; i < all.length; i += options.enqueueBatchSize) {
    await target.enqueueMany(all.slice(i, i + options.enqueueBatchSize));
    batches++;
  }
  const enqueueMs = now() - enqueueStart;
  const processStart = now();
  await target.startConsumers(step.workerConcurrency);
  await target.observeExactCompletions(all.length, options.completionTimeoutMs);
  const processingMs = now() - processStart;
  await target.stop();
  const totalMs = now() - totalStart;
  const completedJobs = target.completedCount();
  return {
    kind: "fixed-batch",
    target: target.metadata.name,
    workerConcurrency: step.workerConcurrency,
    repetition: step.repetition,
    position,
    offeredJobs: all.length,
    enqueuedJobs: all.length,
    completedJobs,
    exactCompletion: completedJobs === all.length,
    phases: { enqueueMs, processingMs, totalMs, productionMs: null, drainMs: null },
    rates: {
      enqueuePerSecond: rate(all.length, enqueueMs),
      processingPerSecond: rate(all.length, processingMs),
      totalPerSecond: rate(all.length, totalMs),
    },
    load: { batches, maxBacklog: all.length, samples: [] },
    telemetry: await telemetryEnd(pool, target, before),
  };
}
async function churnRun(
  pool: Pool,
  target: CompetitorTarget,
  options: CompetitorOptions,
  position: number,
): Promise<CompetitorRunResult> {
  await target.reset();
  await target.setup();
  const before = await telemetryStart(pool, target);
  await target.startConsumers(options.workerConcurrency.at(-1)!);
  const samples: LoadSample[] = [];
  const start = now();
  let enqueued = 0;
  let batches = 0;
  let maxBacklog = 0;
  while (enqueued < options.churnJobs) {
    const expected = Math.floor(((now() - start) / 1000) * options.churnRatePerSecond);
    if (enqueued >= expected) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      continue;
    }
    const size = Math.min(
      options.churnBatchSize,
      options.churnJobs - enqueued,
      Math.max(1, expected - enqueued),
    );
    await target.enqueueMany(items(size, `churn-${target.metadata.name}`, enqueued));
    enqueued += size;
    batches++;
    const backlog = enqueued - target.completedCount();
    maxBacklog = Math.max(maxBacklog, backlog);
    if (
      samples.length === 0 ||
      now() - start - samples.at(-1)!.elapsedMs >= options.sampleIntervalMs
    )
      samples.push({
        elapsedMs: now() - start,
        enqueuedJobs: enqueued,
        completedJobs: target.completedCount(),
        backlog,
      });
  }
  const productionMs = now() - start;
  const drainStart = now();
  await target.observeExactCompletions(options.churnJobs, options.completionTimeoutMs);
  const drainMs = now() - drainStart;
  await target.stop();
  const totalMs = now() - start;
  const completedJobs = target.completedCount();
  return {
    kind: "equal-offered-load-churn",
    target: target.metadata.name,
    workerConcurrency: options.workerConcurrency.at(-1)!,
    repetition: 1,
    position,
    offeredJobs: options.churnJobs,
    enqueuedJobs: enqueued,
    completedJobs,
    exactCompletion: completedJobs === enqueued,
    phases: { enqueueMs: productionMs, processingMs: totalMs, totalMs, productionMs, drainMs },
    rates: {
      enqueuePerSecond: rate(enqueued, productionMs),
      processingPerSecond: rate(completedJobs, totalMs),
      totalPerSecond: rate(completedJobs, totalMs),
    },
    load: { batches, maxBacklog, samples },
    telemetry: await telemetryEnd(pool, target, before),
  };
}
export async function runCompetitorBaseline(
  pool: Pool,
  input: CompetitorOptionsInput = {},
): Promise<CompetitorReport> {
  const options = normalizeCompetitorOptions(input);
  const targets = await createCompetitorTargets(pool);
  const byName = new Map(targets.map((t) => [t.metadata.name, t]));
  const plan = createCompetitorExecutionPlan(
    options.workerConcurrency,
    options.repetitions,
    options.seed,
  );
  const runs: CompetitorRunResult[] = [];
  try {
    for (const step of plan)
      for (const [position, name] of step.targetOrder.entries())
        runs.push(await fixedRun(pool, byName.get(name)!, options, step, position + 1));
    for (const [position, target] of targets.entries())
      runs.push(await churnRun(pool, target, options, position + 1));
    const database =
      (await pool.query("SELECT current_database() AS name, version() AS version")).rows[0] ?? {};
    let gitSha: string | null = null;
    try {
      gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {}
    return {
      artifactVersion: 1,
      generatedAt: new Date(),
      contract: "common-success-path-v1",
      semanticEquivalence: false,
      options,
      provenance: {
        command: `pnpm benchmark:competitors -- --profile ${options.profile}`,
        gitSha,
        node: process.version,
        platform: `${platform()} ${process.arch}`,
        database,
      },
      targets: targets.map((t) => t.metadata),
      executionPlan: plan,
      runs,
      summaries: summarizeCompetitorRuns(runs),
    };
  } finally {
    await Promise.allSettled(targets.map((target) => target.close()));
  }
}
