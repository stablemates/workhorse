import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Pool } from "pg";
import type {
  BenchmarkProfileName,
  BenchmarkRunOptions,
  BenchmarkSuite,
} from "../../benchmarks/run.js";
import {
  operationalScenarioNames,
  type OperationalScenarioName,
} from "../../benchmarks/scenarios.js";
import { assertLocalDatabasePurpose, databaseName } from "../local-database.js";
import { CliUsageError } from "./arguments.js";

export interface BenchmarkCommandOptions {
  readonly databaseUrl: string;
  readonly suite?: string;
  readonly profile?: string;
  readonly scenario?: string;
  readonly seed?: string;
  readonly jobs?: string;
  readonly enqueueBatch?: string;
  readonly repetitions?: string;
  readonly rounds?: string;
  readonly workers?: string;
  readonly churnRate?: string;
  readonly churnJobs?: string;
  readonly sampleMs?: string;
  readonly scheduleSamples?: string;
  readonly output?: string;
}

function positiveInteger(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CliUsageError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CliUsageError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function oneOf<T extends string>(
  value: string | undefined,
  name: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new CliUsageError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function positiveIntegerList(raw: string | undefined, name: string): number[] | undefined {
  if (raw === undefined) return undefined;
  const values = raw.split(",").map((value) => Number(value.trim()));
  if (
    values.length === 0 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 1) ||
    new Set(values).size !== values.length
  ) {
    throw new CliUsageError(`${name} must be a comma-separated list of unique positive integers`);
  }
  return values;
}

function scenarioList(raw: string | undefined): OperationalScenarioName[] | undefined {
  if (raw === undefined) return undefined;
  const scenarios = raw.split(",").map((value) => value.trim()) as OperationalScenarioName[];
  const invalid = scenarios.find((scenario) => !operationalScenarioNames.includes(scenario));
  if (invalid) {
    throw new CliUsageError(
      `Unknown lifecycle scenario ${invalid}. Expected: ${operationalScenarioNames.join(", ")}`,
    );
  }
  return scenarios;
}

function benchmarkRunOptions(options: BenchmarkCommandOptions): BenchmarkRunOptions {
  const seed = nonNegativeInteger(options.seed, "--seed");
  const jobsPerRun = positiveInteger(options.jobs, "--jobs");
  const enqueueBatchSize = positiveInteger(options.enqueueBatch, "--enqueue-batch");
  const repetitions =
    positiveInteger(options.repetitions, "--repetitions") ??
    positiveInteger(options.rounds, "--rounds");
  const workerConcurrency = positiveIntegerList(options.workers, "--workers");
  const targetRatePerSecond = positiveInteger(options.churnRate, "--churn-rate");
  const targetJobs = positiveInteger(options.churnJobs, "--churn-jobs");
  const sampleIntervalMs = positiveInteger(options.sampleMs, "--sample-ms");
  const scheduleSamples = positiveInteger(options.scheduleSamples, "--schedule-samples");
  const scenarios = scenarioList(options.scenario);

  return {
    suite: oneOf<BenchmarkSuite>(options.suite, "--suite", ["all", "comparative", "lifecycle"]),
    profile: oneOf<BenchmarkProfileName>(options.profile, "--profile", [
      "smoke",
      "default",
      "full",
    ]),
    comparative: {
      ...(seed === undefined ? {} : { seed }),
      ...(jobsPerRun === undefined ? {} : { jobsPerRun }),
      ...(enqueueBatchSize === undefined ? {} : { enqueueBatchSize }),
      ...(repetitions === undefined ? {} : { repetitions }),
      ...(workerConcurrency === undefined ? {} : { workerConcurrency }),
      ...(targetRatePerSecond === undefined &&
      targetJobs === undefined &&
      sampleIntervalMs === undefined
        ? {}
        : {
            churn: {
              ...(targetRatePerSecond === undefined ? {} : { targetRatePerSecond }),
              ...(targetJobs === undefined ? {} : { targetJobs }),
              ...(sampleIntervalMs === undefined ? {} : { sampleIntervalMs }),
            },
          }),
    },
    operational: {
      ...(scenarios === undefined ? {} : { scenarios }),
      ...(scheduleSamples === undefined ? {} : { scheduleSamples }),
    },
  };
}

export async function runBenchmarkCommand(options: BenchmarkCommandOptions): Promise<void> {
  assertLocalDatabasePurpose(options.databaseUrl, "bench");
  const [{ resolveBenchmarkRunOptions, runBenchmark }, { toJsonSafe }] = await Promise.all([
    import("../../benchmarks/run.js"),
    import("../../benchmarks/comparative.js"),
  ]);
  const runOptions = benchmarkRunOptions(options);
  const resolved = resolveBenchmarkRunOptions(runOptions);
  const workers = resolved.comparative.workerConcurrency ?? [1];
  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: Math.max(10, ...workers) + 4,
  });
  process.stderr.write(
    `Benchmark target: ${databaseName(options.databaseUrl)} | suite=${resolved.suite} | profile=${resolved.profile}\n`,
  );
  try {
    const report = await runBenchmark(pool, runOptions);
    const json = `${JSON.stringify(toJsonSafe(report), null, 2)}\n`;
    if (options.output) {
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, json);
    }
    process.stdout.write(json);
  } finally {
    await pool.end();
  }
}
