#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { runBenchmark } from "../../benchmarks/run.js";

function integerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const raw = index === -1 ? undefined : process.argv[index + 1];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exitCode = 1;
} else {
  const jobs = integerArgument("--jobs", 1_000);
  const rounds = integerArgument("--rounds", 3);
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
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
