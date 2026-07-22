#!/usr/bin/env node
import { Pool } from "pg";
import { localDatabaseUrl } from "../local-database.js";
import { inspectPgCronRequirements } from "../pg-cron-scheduler.js";

const connectionString =
  process.env.CRON_DATABASE_URL ??
  (() => {
    const url = new URL(localDatabaseUrl("dev"));
    url.pathname = "/postgres";
    return url.toString();
  })();
const pool = new Pool({ connectionString, max: 1 });
try {
  const requirements = await inspectPgCronRequirements(pool);
  console.log(JSON.stringify(requirements, null, 2));
  if (!requirements.ready) process.exitCode = 1;
} finally {
  await pool.end();
}
