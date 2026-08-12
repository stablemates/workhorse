#!/usr/bin/env node
/** Runs the partition-drop against row-delete-and-vacuum retention benchmark. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Pool } from "pg";
import { runRetentionStrategiesBenchmark } from "../benchmarks/retention-strategies.js";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseUrl,
} from "../src/local-database.js";

const help = `Workhorse retention strategy benchmark

Usage:
  pnpm benchmark:retention-strategies -- [options]

Options:
  --rows N[,N...]       History rows inserted per cycle (default: 10,50,100,250,500,1000,10000,50000)
  --cycles N            Churn cycles per strategy and scale (default: 7)
  --retained-cycles N   Generations retained before cleanup (default: 2)
  --ready-jobs N        Constant ready depth for claim probes (default: 500)
  --claim-samples N     Claim probes before, during, and after each cleanup (default: 40)
  --trigger-rows N      Rows per history-trigger repetition (default: 2000)
  --trigger-repetitions N  Trigger-cost repetitions (default: 5)
  --payload-bytes N     History payload bytes per row (default: 128)
  --output PATH         Also write the JSON report to PATH
  --help                Show this help`;

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
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function integerList(name: string): number[] | undefined {
  const raw = argument(name);
  if (raw === undefined) return undefined;
  return raw.split(",").map((part) => {
    const value = Number(part);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must contain positive safe integers`);
    }
    return value;
  });
}

if (process.argv.includes("--help")) {
  console.log(help);
} else {
  const databaseUrl = localDatabaseUrl("bench");
  assertLocalDatabasePurpose(databaseUrl, "bench");
  const pool = new Pool({ connectionString: databaseUrl, max: 16 });
  console.error(`Retention benchmark target: ${databaseName(databaseUrl)}`);
  try {
    const rowsPerCycle = integerList("--rows");
    const cycles = integer("--cycles");
    const retainedCycles = integer("--retained-cycles");
    const readyJobs = integer("--ready-jobs");
    const claimSamples = integer("--claim-samples");
    const triggerRows = integer("--trigger-rows");
    const triggerRepetitions = integer("--trigger-repetitions");
    const payloadBytes = integer("--payload-bytes");
    const report = await runRetentionStrategiesBenchmark(pool, {
      ...(rowsPerCycle === undefined ? {} : { rowsPerCycle }),
      ...(cycles === undefined ? {} : { cycles }),
      ...(retainedCycles === undefined ? {} : { retainedCycles }),
      ...(readyJobs === undefined ? {} : { readyJobs }),
      ...(claimSamples === undefined ? {} : { claimSamples }),
      ...(triggerRows === undefined ? {} : { triggerRows }),
      ...(triggerRepetitions === undefined ? {} : { triggerRepetitions }),
      ...(payloadBytes === undefined ? {} : { payloadBytes }),
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
