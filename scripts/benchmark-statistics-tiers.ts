#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Pool } from "pg";
import { runStatisticsTiersBenchmark } from "../typescript/core/benchmarks/statistics-tiers.js";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseUrl,
} from "../typescript/core/src/local-database.js";

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

const databaseUrl = localDatabaseUrl("bench");
assertLocalDatabasePurpose(databaseUrl, "bench");
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
console.error(`Statistics tier benchmark target: ${databaseName(databaseUrl)}`);
try {
  const jobs = integer("--jobs");
  const days = integer("--days");
  const payloadBytes = integer("--payload-bytes");
  const repetitions = integer("--repetitions");
  const warmupRepetitions = integer("--warmup");
  const report = await runStatisticsTiersBenchmark(pool, {
    ...(jobs === undefined ? {} : { jobs }),
    ...(days === undefined ? {} : { days }),
    ...(payloadBytes === undefined ? {} : { payloadBytes }),
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
