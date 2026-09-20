#!/usr/bin/env node
/** Measures what a claim on a saturated keyed queue locks and writes (SM-801). */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Pool } from "pg";
import { runSaturatedClaimBenchmark } from "../typescript/core/benchmarks/saturated-claim.js";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseUrl,
} from "../typescript/core/src/local-database.js";

const help = `Workhorse saturated claim benchmark

Usage:
  pnpm benchmark:saturated-claim -- [options]

Options:
  --keys N                Distinct concurrency keys, all at capacity (default: 40)
  --ready-per-key N       Ready rows per key (default: 4)
  --max-active-per-key N  Per-key concurrency limit (default: 1)
  --samples N             Measured claims per series (default: 25)
  --warmup N              Unmeasured claims before each series (default: 2)
  --no-install            Measure the schema already installed in the benchmark database
  --output PATH           Also write the JSON report to PATH
  --help                  Show this help`;

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
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
console.error(`Saturated claim benchmark target: ${databaseName(databaseUrl)}`);
try {
  const report = await runSaturatedClaimBenchmark(pool, {
    keys: integer("--keys"),
    readyPerKey: integer("--ready-per-key"),
    maxActivePerKey: integer("--max-active-per-key"),
    samples: integer("--samples"),
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
