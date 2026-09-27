#!/usr/bin/env node
/** Compares the full-tier enqueue before and after it became set-based (SM-911, SM-943). */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Pool } from "pg";
import { runSetBasedEnqueueBenchmark } from "../typescript/core/benchmarks/set-based-enqueue.js";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseUrl,
} from "../typescript/core/src/local-database.js";

const help = `Workhorse set-based enqueue benchmark

Usage:
  pnpm benchmark:set-based-enqueue -- [options]

Options:
  --versions A,B,...  Schema versions to compare; the first is the baseline (default: 26,27,current)
  --rounds N          Rounds; each rebuilds every arm once, alternating the order (default: 4)
  --samples N         Measured samples per scenario per arm per round (default: 10)
  --warmup N          Unmeasured samples before each series (default: 2)
  --output PATH       Also write the JSON report to PATH
  --help              Show this help`;

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
console.error(`Set-based enqueue benchmark target: ${databaseName(databaseUrl)}`);
try {
  const report = await runSetBasedEnqueueBenchmark(pool, {
    versions: argument("--versions")?.split(",").map(Number),
    rounds: integer("--rounds"),
    samples: integer("--samples"),
    warmupSamples: integer("--warmup"),
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
