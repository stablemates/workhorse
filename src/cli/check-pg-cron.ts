#!/usr/bin/env node
import { Pool } from "pg";
import type { LocalDatabasePurpose } from "../local-database.js";
import { isLocalDatabasePurpose, localDatabaseUrl } from "../local-database.js";
import { inspectPgCronRequirements, verifyPgCronExecution } from "../pg-cron-scheduler.js";

const purposeIndex = process.argv.indexOf("--database");
const purposeArgument = purposeIndex === -1 ? undefined : process.argv[purposeIndex + 1];
let purpose: LocalDatabasePurpose | undefined;
if (purposeArgument) {
  if (!isLocalDatabasePurpose(purposeArgument)) {
    throw new Error("--database must be dev, test, or bench");
  }
  purpose = purposeArgument;
}
const targetConnectionString = purpose
  ? localDatabaseUrl(purpose)
  : (process.env.DATABASE_URL ?? localDatabaseUrl("dev"));
const targetDatabase = new URL(targetConnectionString).pathname.slice(1);
const cronConnectionString =
  process.env.CRON_DATABASE_URL ??
  (() => {
    const url = new URL(targetConnectionString);
    url.pathname = "/postgres";
    return url.toString();
  })();
const pool = new Pool({ connectionString: cronConnectionString, max: 1 });
try {
  const requirements = await inspectPgCronRequirements(pool);
  const execution = requirements.metadataReady
    ? await verifyPgCronExecution(pool, targetDatabase)
    : { executionReady: false, status: null, message: "metadata requirements are not satisfied" };
  const result = {
    ready: requirements.metadataReady && execution.executionReady,
    ...requirements,
    ...execution,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
} finally {
  await pool.end();
}
