#!/usr/bin/env node
import { Pool } from "pg";
import { Queue } from "../index.js";
import {
  isLocalDatabasePurpose,
  localDatabaseUrl,
  type LocalDatabasePurpose,
} from "../local-database.js";

const purposeIndex = process.argv.indexOf("--database");
let localPurpose: LocalDatabasePurpose | undefined;
if (purposeIndex !== -1) {
  const purposeArgument = process.argv[purposeIndex + 1];
  if (!purposeArgument || !isLocalDatabasePurpose(purposeArgument)) {
    throw new Error("--database must be dev, test, or bench");
  }
  localPurpose = purposeArgument;
}

// Repository scripts pass an explicit local purpose. The packaged CLI retains DATABASE_URL for
// inspecting an application-owned database without imposing Workhorse's local naming convention.
const databaseUrl = localPurpose ? localDatabaseUrl(localPurpose) : process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL is required unless --database selects a local role");
const pool = new Pool({ connectionString: databaseUrl });
try {
  // Emit only JSON so automation can consume stdout. Exit 2 is reserved for queue degradation
  // reported by the canonical budget evaluation.
  const health = await new Queue(pool).health();
  console.log(JSON.stringify(health, null, 2));
  if (health.status.level === "degraded") process.exitCode = 2;
} finally {
  await pool.end();
}
