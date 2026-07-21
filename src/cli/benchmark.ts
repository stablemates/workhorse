#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Pool } from "pg";
import {
  resolveBenchmarkRunOptions,
  runBenchmark,
  type BenchmarkProfileName,
  type BenchmarkRunOptions,
  type BenchmarkSuite,
} from "../../benchmarks/run.js";
import { toJsonSafe } from "../../benchmarks/comparative.js";
import {
  operationalScenarioNames,
  type OperationalScenarioName,
} from "../../benchmarks/scenarios.js";
import { assertLocalDatabasePurpose, databaseName, localDatabaseUrl } from "../local-database.js";

const help = `Ironshift benchmark suite v3

Usage:
  pnpm benchmark -- [options]

Suite selection:
  --suite NAME       all, comparative, or lifecycle (default: all)
  --profile NAME     smoke, default, or full (default: default)
  --scenario NAMES   Comma-separated lifecycle scenarios

Comparative overrides:
  --seed N           Non-negative deterministic execution-plan seed
  --jobs N           Jobs per independent run
  --enqueue-batch N  Jobs per enqueueMany request
  --repetitions N    Independent reset-and-run repetitions
  --rounds N         Legacy alias for --repetitions
  --workers NAMES    Comma-separated worker sweep, for example 1,4,16
  --churn-rate N     Fixed producer target jobs per second
  --churn-jobs N     Exact jobs produced and completed per design
  --sample-ms N      Churn telemetry sample interval in milliseconds

Output:
  --output PATH      Also write the canonical versioned JSON report to PATH
  --help             Show this help

The suite resets Ironshift and benchmark-only tables while running. It only accepts a _bench database.
Override the local default with IRONSHIFT_BENCH_DATABASE_URL. See docs/benchmarking.md.`;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function positiveInteger(name: string): number | undefined {
  const raw = argument(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(name: string): number | undefined {
  const raw = argument(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function oneOf<T extends string>(name: string, allowed: readonly T[]): T | undefined {
  const value = argument(name);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function positiveIntegerList(name: string): number[] | undefined {
  const raw = argument(name);
  if (raw === undefined) return undefined;
  const values = raw.split(",").map((value) => Number(value.trim()));
  if (
    values.length === 0 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 1) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`${name} must be a comma-separated list of unique positive integers`);
  }
  return values;
}

function scenarioList(): OperationalScenarioName[] | undefined {
  const raw = argument("--scenario");
  if (raw === undefined) return undefined;
  const scenarios = raw.split(",").map((value) => value.trim()) as OperationalScenarioName[];
  const invalid = scenarios.find((scenario) => !operationalScenarioNames.includes(scenario));
  if (invalid) {
    throw new Error(
      `Unknown lifecycle scenario ${invalid}. Expected: ${operationalScenarioNames.join(", ")}`,
    );
  }
  return scenarios;
}

function cliOptions(): BenchmarkRunOptions {
  const seed = nonNegativeInteger("--seed");
  const jobsPerRun = positiveInteger("--jobs");
  const enqueueBatchSize = positiveInteger("--enqueue-batch");
  const repetitions = positiveInteger("--repetitions") ?? positiveInteger("--rounds");
  const workerConcurrency = positiveIntegerList("--workers");
  const targetRatePerSecond = positiveInteger("--churn-rate");
  const targetJobs = positiveInteger("--churn-jobs");
  const sampleIntervalMs = positiveInteger("--sample-ms");
  const scenarios = scenarioList();

  return {
    suite: oneOf<BenchmarkSuite>("--suite", ["all", "comparative", "lifecycle"]),
    profile: oneOf<BenchmarkProfileName>("--profile", ["smoke", "default", "full"]),
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
    operational: scenarios === undefined ? {} : { scenarios },
  };
}

const databaseUrl = localDatabaseUrl("bench");
if (process.argv.includes("--help")) {
  console.log(help);
} else {
  assertLocalDatabasePurpose(databaseUrl, "bench");
  const options = cliOptions();
  const resolved = resolveBenchmarkRunOptions(options);
  const workers = resolved.comparative.workerConcurrency ?? [1];
  const pool = new Pool({ connectionString: databaseUrl, max: Math.max(10, ...workers) + 4 });
  const output = argument("--output");
  console.error(
    `Benchmark target: ${databaseName(databaseUrl)} | suite=${resolved.suite} | profile=${resolved.profile}`,
  );
  try {
    const report = await runBenchmark(pool, options);
    const json = `${JSON.stringify(toJsonSafe(report), null, 2)}\n`;
    if (output) {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, json);
    }
    console.log(json);
  } finally {
    await pool.end();
  }
}
