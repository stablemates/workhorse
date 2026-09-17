#!/usr/bin/env node
/** Runs the high-tenant-cardinality admission and read benchmark (ADR 0068). */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Pool } from "pg";
import { runTenantCardinalityBenchmark } from "../typescript/core/benchmarks/tenant-cardinality.js";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseUrl,
} from "../typescript/core/src/local-database.js";

const help = `Workhorse tenant cardinality benchmark

Usage:
  pnpm benchmark:tenant-cardinality -- [options]

Options:
  --tenants N[,N...]      Distinct tenants per rung (default: 100,1000,10000,100000)
  --tasks-per-tenant N    Ready rows per tenant (default: 2)
  --saturated-tenants N   Head-of-queue tenants already at capacity (default: 40)
  --max-active-per-key N  Per-key and per-budget cap (default: 2)
  --claim-samples N       Measured claim_v1 calls per rung (default: 25)
  --read-samples N        Measured read probes per rung (default: 10)
  --warmup N              Unmeasured calls before each series (default: 2)
  --profiles P[,P]        keyed, budgeted, or both (default: keyed,budgeted)
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

function profiles(): ("keyed" | "budgeted")[] | undefined {
  const raw = argument("--profiles");
  if (raw === undefined) return undefined;
  return raw.split(",").map((part) => {
    if (part !== "keyed" && part !== "budgeted") {
      throw new Error("--profiles accepts keyed and budgeted");
    }
    return part;
  });
}

if (process.argv.includes("--help")) {
  console.log(help);
  process.exit(0);
}

const databaseUrl = localDatabaseUrl("bench");
assertLocalDatabasePurpose(databaseUrl, "bench");
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
console.error(`Tenant cardinality benchmark target: ${databaseName(databaseUrl)}`);
try {
  const tenants = integerList("--tenants");
  const tasksPerTenant = integer("--tasks-per-tenant");
  const saturatedTenants = integer("--saturated-tenants");
  const maxActivePerKey = integer("--max-active-per-key");
  const claimSamples = integer("--claim-samples");
  const readSamples = integer("--read-samples");
  const warmupSamples = integer("--warmup");
  const selectedProfiles = profiles();
  const report = await runTenantCardinalityBenchmark(
    pool,
    {
      ...(tenants === undefined ? {} : { tenants }),
      ...(tasksPerTenant === undefined ? {} : { tasksPerTenant }),
      ...(saturatedTenants === undefined ? {} : { saturatedTenants }),
      ...(maxActivePerKey === undefined ? {} : { maxActivePerKey }),
      ...(claimSamples === undefined ? {} : { claimSamples }),
      ...(readSamples === undefined ? {} : { readSamples }),
      ...(warmupSamples === undefined ? {} : { warmupSamples }),
      ...(selectedProfiles === undefined ? {} : { profiles: selectedProfiles }),
    },
    (line) => console.error(line),
  );
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
