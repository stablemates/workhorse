import { execFileSync } from "node:child_process";
import { cpus, platform, release, totalmem } from "node:os";
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
    settings: Record<string, string>;
  };
  provenance: {
    command: string[];
    runtime: {
      nodeVersion: string;
      platform: string;
      release: string;
      architecture: string;
      cpuModel: string | null;
      logicalCpuCount: number;
      totalMemoryBytes: number;
    };
    source: {
      commit: string | null;
      dirty: boolean | null;
    };
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

const recordedPostgresSettings = [
  "autovacuum",
  "autovacuum_naptime",
  "checkpoint_timeout",
  "maintenance_work_mem",
  "max_connections",
  "max_wal_size",
  "shared_buffers",
  "synchronous_commit",
  "work_mem",
] as const;

function gitOutput(arguments_: string[]): string | null {
  try {
    return execFileSync("git", arguments_, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function captureBenchmarkProvenance(): BenchmarkReportV2["provenance"] {
  const cpuList = cpus();
  const commit = gitOutput(["rev-parse", "HEAD"]);
  const status = gitOutput(["status", "--porcelain", "--untracked-files=no"]);
  return {
    command: [...process.argv],
    runtime: {
      nodeVersion: process.version,
      platform: platform(),
      release: release(),
      architecture: process.arch,
      cpuModel: cpuList[0]?.model ?? null,
      logicalCpuCount: cpuList.length,
      totalMemoryBytes: totalmem(),
    },
    source: {
      commit: commit === "" ? null : commit,
      dirty: status === null ? null : status !== "",
    },
  };
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
  const settings = await pool.query<{ name: string; value: string }>(
    `SELECT name, setting || COALESCE(unit, '') AS value
       FROM pg_settings
      WHERE name = ANY($1::text[])
      ORDER BY name`,
    [[...recordedPostgresSettings]],
  );
  const row = environment.rows[0];
  if (!row) throw new Error("Unable to read PostgreSQL benchmark environment");

  const report: BenchmarkReportV2 = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    suite: options.suite,
    profile: options.profile,
    environment: {
      database: row.database,
      postgresVersion: row.version,
      settings: Object.fromEntries(settings.rows.map(({ name, value }) => [name, value])),
    },
    provenance: captureBenchmarkProvenance(),
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
