import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type {
  BenchmarkProfileName,
  BenchmarkRunOptions,
  BenchmarkSuite,
} from "../../benchmarks/run.js";
import type { OperationalScenarioName } from "../../benchmarks/scenarios.js";
import { assertLocalDatabasePurpose, databaseName, localDatabaseUrl } from "../local-database.js";
import { CliUsageError, parseCommandArgs, USAGE_EXIT_CODE } from "./arguments.js";

const HELP = `Workhorse benchmark suite v3

Usage:
  pnpm benchmark -- [options]

Suite selection:
  --suite <name>             all, comparative, or lifecycle (default: all).
  --profile <name>           smoke, default, or full (default: default).
  --scenario <names>         Comma-separated lifecycle scenarios.

Comparative overrides:
  --seed <number>            Non-negative deterministic execution-plan seed.
  --jobs <number>            Jobs per independent run.
  --enqueue-batch <number>   Jobs per enqueueMany request.
  --repetitions <number>     Independent reset-and-run repetitions.
  --rounds <number>          Legacy alias for --repetitions.
  --workers <numbers>        Comma-separated worker sweep, for example 1,4,16.
  --churn-rate <number>      Fixed producer target jobs per second.
  --churn-jobs <number>      Exact jobs produced and completed per design.
  --sample-ms <number>       Churn telemetry sample interval in milliseconds.
  --schedule-samples <number>
                             Recurring occurrences sampled under worker load.

Output:
  --output <path>            Also write the canonical versioned JSON report.
  --help, -h                 Show this help.

The suite resets Workhorse and benchmark-only tables while running. It only accepts a _bench
database. See docs/benchmarking.md.
`;

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

function scenarioList(
  raw: string | undefined,
  operationalScenarioNames: readonly OperationalScenarioName[],
): OperationalScenarioName[] | undefined {
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

function benchmarkRunOptions(
  options: BenchmarkCommandOptions,
  operationalScenarioNames: readonly OperationalScenarioName[],
): BenchmarkRunOptions {
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
  const scenarios = scenarioList(options.scenario, operationalScenarioNames);

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
  const [
    { resolveBenchmarkRunOptions, runBenchmark },
    { toJsonSafe },
    { operationalScenarioNames },
  ] = await Promise.all([
    import("../../benchmarks/run.js"),
    import("../../benchmarks/comparative.js"),
    import("../../benchmarks/scenarios.js"),
  ]);
  const runOptions = benchmarkRunOptions(options, operationalScenarioNames);
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

async function main(args: readonly string[]): Promise<void> {
  const commandArgs = args[0] === "--" ? args.slice(1) : args;
  const { values } = parseCommandArgs("benchmark", {
    args: commandArgs,
    options: {
      suite: { type: "string" },
      profile: { type: "string" },
      scenario: { type: "string" },
      seed: { type: "string" },
      jobs: { type: "string" },
      "enqueue-batch": { type: "string" },
      repetitions: { type: "string" },
      rounds: { type: "string" },
      workers: { type: "string" },
      "churn-rate": { type: "string" },
      "churn-jobs": { type: "string" },
      "sample-ms": { type: "string" },
      "schedule-samples": { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  await runBenchmarkCommand({
    databaseUrl: localDatabaseUrl("bench"),
    suite: values.suite,
    profile: values.profile,
    scenario: values.scenario,
    seed: values.seed,
    jobs: values.jobs,
    enqueueBatch: values["enqueue-batch"],
    repetitions: values.repetitions,
    rounds: values.rounds,
    workers: values.workers,
    churnRate: values["churn-rate"],
    churnJobs: values["churn-jobs"],
    sampleMs: values["sample-ms"],
    scheduleSamples: values["schedule-samples"],
    output: values.output,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof CliUsageError) {
      process.stderr.write(`Error: ${error.message}\n`);
      process.exitCode = USAGE_EXIT_CODE;
    } else {
      console.error(error instanceof Error ? (error.stack ?? error.message) : error);
      process.exitCode = 1;
    }
  });
}
