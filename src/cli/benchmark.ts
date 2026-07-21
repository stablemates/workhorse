#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { runBenchmark } from "../../benchmarks/run.js";

const help = `Ironshift benchmark

Usage:
  DATABASE_URL=postgres://... pnpm benchmark -- [options]

Options:
  --jobs N       Jobs per design per round (default: 1000)
  --rounds N     Retained-history rounds (default: 3)
  --output PATH  Also write the JSON report to PATH
  --help          Show this help

The benchmark truncates Ironshift and benchmark tables at startup. Use a dedicated test database.
See docs/benchmarking.md for methodology, interpretation, scale runs, and limitations.`;

function integerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const raw = index === -1 ? undefined : process.argv[index + 1];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const databaseUrl = process.env.DATABASE_URL;
if (process.argv.includes("--help")) {
  console.log(help);
} else if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exitCode = 1;
} else {
  const jobs = integerArgument("--jobs", 1_000);
  const rounds = integerArgument("--rounds", 3);
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
  if (outputIndex !== -1 && (!output || output.startsWith("--")))
    throw new Error("--output requires a path");
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  try {
    const report = {
      generatedAt: new Date().toISOString(),
      database: (await pool.query<{ version: string }>("SELECT version() AS version")).rows[0]!
        .version,
      settings: { jobs, rounds },
      results: await runBenchmark(pool, { jobs, rounds }),
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (output) await writeFile(output, json);
    console.log(json);
  } finally {
    await pool.end();
  }
}
