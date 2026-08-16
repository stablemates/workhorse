import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Pool } from "pg";
import type { CompetitorProfileName } from "../../benchmarks/competitor-baseline.js";
import { assertLocalDatabasePurpose } from "../local-database.js";
import { CliUsageError } from "./arguments.js";

export interface CompetitorBenchmarkCommandOptions {
  readonly databaseUrl: string;
  readonly profile?: string;
  readonly output?: string;
  readonly pgBossBatchSize?: string;
}

export async function runCompetitorBenchmarkCommand(
  options: CompetitorBenchmarkCommandOptions,
): Promise<void> {
  const { normalizeCompetitorOptions, runCompetitorBaseline, stringifyCompetitorReport } =
    await import("../../benchmarks/competitor-baseline.js");
  const profileValue = options.profile ?? "default";
  if (profileValue !== "smoke" && profileValue !== "default") {
    throw new CliUsageError("--profile must be smoke or default");
  }
  const profile: CompetitorProfileName = profileValue;
  const pgBossBatchSize =
    options.pgBossBatchSize === undefined ? 1 : Number(options.pgBossBatchSize);
  assertLocalDatabasePurpose(options.databaseUrl, "bench");
  const pool = new Pool({ connectionString: options.databaseUrl, max: 32 });
  pool.on("error", (error) => {
    console.error("Unexpected competitor benchmark pool error", error);
  });
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      console.error("Unexpected competitor benchmark client error", error);
    });
  });
  try {
    const report = await runCompetitorBaseline(
      pool,
      normalizeCompetitorOptions({ profile, pgBossBatchSize }),
    );
    const json = stringifyCompetitorReport(report);
    if (options.output) {
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, json);
    }
    process.stdout.write(`${json.replace(/\n$/, "")}\n`);
  } finally {
    await pool.end();
  }
}
