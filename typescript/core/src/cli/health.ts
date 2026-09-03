import { Pool } from "pg";
import { Queue } from "../index.js";
import { DEGRADED_EXIT_CODE, type CliJsonPayloads } from "./surface.js";

export interface HealthCommandOptions {
  readonly databaseUrl: string;
  readonly json: boolean;
}

export async function runHealthCommand(options: HealthCommandOptions): Promise<void> {
  const pool = new Pool({ connectionString: options.databaseUrl });
  try {
    const health: CliJsonPayloads["health"] = await new Queue(pool).health();
    if (options.json) {
      process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
    } else {
      process.stdout.write(`Workhorse queue is ${health.status.level}.\n`);
      for (const reason of health.status.reasons) {
        process.stdout.write(
          `- ${reason.code}: observed ${reason.observed}, budget ${reason.budget}\n`,
        );
      }
    }
    // The degraded code is reserved for recoverable queue degradation. Usage errors use EX_USAGE,
    // so automation can distinguish an unhealthy queue from a malformed command.
    if (health.status.level !== "healthy") process.exitCode = DEGRADED_EXIT_CODE;
  } finally {
    await pool.end();
  }
}
