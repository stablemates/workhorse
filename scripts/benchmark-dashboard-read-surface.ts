#!/usr/bin/env node
/** Compares direct, view-backed, and function-backed dashboard reads on a loaded database. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Pool } from "pg";
import { runDashboardReadSurfaceBenchmark } from "../typescript/core/benchmarks/dashboard-read-surface.js";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseUrl,
} from "../typescript/core/src/local-database.js";

const help = `Workhorse dashboard read-surface benchmark

Usage:
  pnpm benchmark:dashboard-read-surface -- [options]

Options:
  --jobs N          Total loaded jobs (default: 100000)
  --live-jobs N     Jobs with live runtime rows (default: 20000)
  --repetitions N   Measured EXPLAIN repetitions per query and strategy (default: 7)
  --warmup N        Discarded EXPLAIN repetitions per query and strategy (default: 2)
  --output PATH     Also write the JSON report to PATH
  --help            Show this help

This command recreates the workhorse schema in the checkout's dedicated benchmark database.`;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function integer(name: string): number | undefined {
  const raw = argument(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

if (process.argv.includes("--help")) {
  console.log(help);
} else {
  const databaseUrl = localDatabaseUrl("bench");
  assertLocalDatabasePurpose(databaseUrl, "bench");
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  console.error(`Dashboard read benchmark target: ${databaseName(databaseUrl)}`);
  try {
    const jobs = integer("--jobs");
    const liveJobs = integer("--live-jobs");
    const repetitions = integer("--repetitions");
    const warmupRepetitions = integer("--warmup");
    const report = await runDashboardReadSurfaceBenchmark(pool, {
      ...(jobs === undefined ? {} : { jobs }),
      ...(liveJobs === undefined ? {} : { liveJobs }),
      ...(repetitions === undefined ? {} : { repetitions }),
      ...(warmupRepetitions === undefined ? {} : { warmupRepetitions }),
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const output = argument("--output");
    if (output) {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, json);
    }
    console.log(json);
  } finally {
    await pool.end();
  }
}
