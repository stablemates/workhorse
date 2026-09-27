#!/usr/bin/env node
/** Measures what a delayed backlog above due work costs a fast-tier claim (SM-942). */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Pool } from "pg";
import { runFastClaimBacklogBenchmark } from "../typescript/core/benchmarks/fast-claim-backlog.js";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseUrl,
} from "../typescript/core/src/local-database.js";

const help = `Workhorse fast claim backlog benchmark

Usage:
  pnpm benchmark:fast-claim-backlog -- [options]

Options:
  --backlogs N,N,...  Delayed rows per queue, one load per value (default: 1000,10000,100000)
  --due-rows N        Due rows in each queue that has due work (default: 200)
  --limit N           Tasks each claim asks for (default: 1)
  --rounds N          Alternating rounds per backlog size (default: 5)
  --samples N         Measured claims per series per round (default: 40)
  --warmup N          Unmeasured claims per series before the rounds (default: 5)
  --no-install        Measure the schema already installed in the benchmark database
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
console.error(`Fast claim backlog benchmark target: ${databaseName(databaseUrl)}`);
try {
  const report = await runFastClaimBacklogBenchmark(pool, {
    backlogs: argument("--backlogs")?.split(",").map(Number),
    dueRows: integer("--due-rows"),
    limit: integer("--limit"),
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
