#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Pool } from "pg";
import {
  normalizeCompetitorOptions,
  runCompetitorBaseline,
  stringifyCompetitorReport,
  type CompetitorProfileName,
} from "../../benchmarks/competitor-baseline.js";
import { databaseName, localDatabaseUrl } from "../local-database.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
const help = `Standalone competitor baseline\n\nUsage:\n  pnpm benchmark:competitors -- --profile smoke|default --output PATH\n\nThe command only accepts the configured _bench database and resets the isolated schemas ironshift, pgboss_competitor, and graphile_worker_competitor.`;
async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(help);
    return;
  }
  const profile = (argument("--profile") ?? "default") as CompetitorProfileName;
  if (!(["smoke", "default"] as const).includes(profile))
    throw new Error("--profile must be smoke or default");
  const output = argument("--output");
  const url = localDatabaseUrl("bench");
  if (!databaseName(url).endsWith("_bench"))
    throw new Error("competitor benchmark requires a database name ending in _bench");
  const pool = new Pool({ connectionString: url });
  pool.on("error", (error) => {
    console.error("Unexpected competitor benchmark pool error", error);
  });
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      console.error("Unexpected competitor benchmark client error", error);
    });
  });
  try {
    const report = await runCompetitorBaseline(pool, normalizeCompetitorOptions({ profile }));
    const json = stringifyCompetitorReport(report);
    if (output) {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, json);
    }
    console.log(json);
  } finally {
    await pool.end();
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
