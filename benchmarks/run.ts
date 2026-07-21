import type { Pool } from "pg";
import {
  runComparativeBenchmark,
  type ComparativeBenchmarkOptionsInput,
  type ComparativeBenchmarkResult,
} from "./comparative.js";
import {
  runOperationalScenarios,
  type OperationalScenarioOptions,
  type OperationalScenarioReport,
} from "./scenarios.js";

export type BenchmarkSuite = "all" | "comparative" | "lifecycle";
export type BenchmarkProfileName = "smoke" | "default" | "full";

export interface BenchmarkRunOptions {
  suite?: BenchmarkSuite;
  profile?: BenchmarkProfileName;
  comparative?: ComparativeBenchmarkOptionsInput;
  operational?: OperationalScenarioOptions;
}

export interface ResolvedBenchmarkRunOptions {
  suite: BenchmarkSuite;
  profile: BenchmarkProfileName;
  comparative: ComparativeBenchmarkOptionsInput;
  operational: OperationalScenarioOptions;
}

export interface BenchmarkReportV2 {
  schemaVersion: 2;
  generatedAt: string;
  suite: BenchmarkSuite;
  profile: BenchmarkProfileName;
  environment: {
    database: string;
    postgresVersion: string;
  };
  configuration: {
    comparative: ComparativeBenchmarkOptionsInput;
    operational: OperationalScenarioOptions;
  };
  comparative?: ComparativeBenchmarkResult;
  lifecycle?: OperationalScenarioReport;
}

interface BenchmarkProfile {
  comparative: ComparativeBenchmarkOptionsInput;
  operational: OperationalScenarioOptions;
}

export const benchmarkProfiles: Readonly<Record<BenchmarkProfileName, BenchmarkProfile>> = {
  smoke: {
    comparative: {
      jobsPerRun: 12,
      repetitions: 2,
      workerConcurrency: [1, 2],
      leaseMs: 5_000,
      churn: { durationMs: 500, batchSize: 4, sampleIntervalMs: 100, workerConcurrency: 2 },
    },
    operational: {
      jobCount: 6,
      heartbeatCount: 3,
      batchSize: 3,
      scheduleDelayMs: 30,
      leaseMs: 100,
      retryDelayMs: 30,
      pruneLimit: 100,
    },
  },
  default: {
    comparative: {
      jobsPerRun: 100,
      repetitions: 3,
      workerConcurrency: [1, 4, 8],
      leaseMs: 30_000,
      churn: { durationMs: 5_000, batchSize: 25, sampleIntervalMs: 500, workerConcurrency: 4 },
    },
    operational: {
      jobCount: 24,
      heartbeatCount: 8,
      batchSize: 8,
      scheduleDelayMs: 75,
      leaseMs: 150,
      retryDelayMs: 75,
      pruneLimit: 1_000,
    },
  },
  full: {
    comparative: {
      jobsPerRun: 1_000,
      repetitions: 5,
      workerConcurrency: [1, 4, 16, 32],
      leaseMs: 30_000,
      churn: { durationMs: 60_000, batchSize: 100, sampleIntervalMs: 1_000, workerConcurrency: 16 },
    },
    operational: {
      jobCount: 100,
      heartbeatCount: 32,
      batchSize: 25,
      scheduleDelayMs: 100,
      leaseMs: 200,
      retryDelayMs: 100,
      pruneLimit: 10_000,
    },
  },
};

function cloneComparativeOptions(
  options: ComparativeBenchmarkOptionsInput,
): ComparativeBenchmarkOptionsInput {
  return {
    ...options,
    workerConcurrency: options.workerConcurrency ? [...options.workerConcurrency] : undefined,
    churn: options.churn ? { ...options.churn } : undefined,
  };
}

function cloneOperationalOptions(options: OperationalScenarioOptions): OperationalScenarioOptions {
  return {
    ...options,
    scenarios: options.scenarios ? [...options.scenarios] : undefined,
  };
}

export function resolveBenchmarkRunOptions(
  input: BenchmarkRunOptions = {},
): ResolvedBenchmarkRunOptions {
  const profile = input.profile ?? "default";
  const suite = input.suite ?? "all";
  const selected = benchmarkProfiles[profile];
  const comparative = cloneComparativeOptions(selected.comparative);
  const operational = cloneOperationalOptions(selected.operational);

  return {
    suite,
    profile,
    comparative: {
      ...comparative,
      ...input.comparative,
      workerConcurrency: input.comparative?.workerConcurrency ?? comparative.workerConcurrency,
      churn: { ...comparative.churn, ...input.comparative?.churn },
    },
    operational: {
      ...operational,
      ...input.operational,
      scenarios: input.operational?.scenarios ?? operational.scenarios,
    },
  };
}

export async function runBenchmark(
  pool: Pool,
  input: BenchmarkRunOptions = {},
): Promise<BenchmarkReportV2> {
  const options = resolveBenchmarkRunOptions(input);
  const environment = await pool.query<{ database: string; version: string }>(
    "SELECT current_database() AS database, version() AS version",
  );
  const row = environment.rows[0];
  if (!row) throw new Error("Unable to read PostgreSQL benchmark environment");

  const report: BenchmarkReportV2 = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    suite: options.suite,
    profile: options.profile,
    environment: { database: row.database, postgresVersion: row.version },
    configuration: {
      comparative: options.comparative,
      operational: options.operational,
    },
  };

  if (options.suite === "all" || options.suite === "comparative") {
    report.comparative = await runComparativeBenchmark(pool, options.comparative);
  }
  if (options.suite === "all" || options.suite === "lifecycle") {
    report.lifecycle = await runOperationalScenarios(pool, options.operational);
  }

  return report;
}
