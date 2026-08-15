#!/usr/bin/env node
/**
 * Runs the metric instrument lifecycle microbenchmark and prints its JSON report.
 *
 * This benchmark needs no database. See typescript/core/benchmarks/metrics-lifecycle.ts and ADR 0024.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { runMetricsLifecycleBenchmark } from "../typescript/core/benchmarks/metrics-lifecycle.js";

const help = `Workhorse metric lifecycle benchmark

Usage:
  pnpm benchmark:metrics-lifecycle -- [options]

Options:
  --emissions N      Emissions per repetition (default: 1000000)
  --repetitions N    Measured repetitions per lifecycle and provider state (default: 12)
  --warmup N         Discarded warmup repetitions (default: 3)
  --output PATH      Also write the JSON report to PATH
  --help             Show this help`;

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
  const emissionsPerRepetition = integer("--emissions");
  const repetitions = integer("--repetitions");
  const warmupRepetitions = integer("--warmup");
  const report = await runMetricsLifecycleBenchmark({
    ...(emissionsPerRepetition === undefined ? {} : { emissionsPerRepetition }),
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
}
