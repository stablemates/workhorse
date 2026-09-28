#!/usr/bin/env node
/** Measures what the exact-zero guard costs a dependency release (SM-937). */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Pool } from "pg";
import { runDependencyReleaseGuardBenchmark } from "../typescript/core/benchmarks/dependency-release-guard.js";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseUrl,
} from "../typescript/core/src/local-database.js";

const help = `Workhorse dependency release guard benchmark

Usage:
  pnpm benchmark:dependency-release-guard -- [options]

Options:
  --rounds N      Alternating rounds per shape (default: 5)
  --samples N     Measured calls per series per round (default: 100)
  --warmup N      Unmeasured calls per series before the rounds (default: 10)
  --no-install    Measure the schema already installed in the benchmark database
  --output PATH   Also write the JSON report to PATH
  --help          Show this help`;

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
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be an integer`);
  return value;
}

if (process.argv.includes("--help")) {
  console.log(help);
  process.exit(0);
}

const databaseUrl = localDatabaseUrl("bench");
assertLocalDatabasePurpose(databaseUrl, "bench");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
console.error(`Dependency release guard benchmark target: ${databaseName(databaseUrl)}`);
try {
  const report = await runDependencyReleaseGuardBenchmark(pool, {
    rounds: integer("--rounds"),
    samplesPerRound: integer("--samples"),
    warmupSamples: integer("--warmup"),
    install: process.argv.includes("--no-install") ? false : undefined,
  });
  const output = argument("--output");
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.error(`Wrote ${output}`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
