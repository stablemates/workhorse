#!/usr/bin/env node
import { Pool } from "pg";
import { Queue } from "../index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    // Emit only JSON so automation can consume stdout. Exit 2 is reserved for recoverable queue
    // degradation: an expired lease exists and a recovery worker may not be keeping up.
    const health = await new Queue(pool).health();
    console.log(JSON.stringify(health, null, 2));
    if (health.expiredLeases > 0) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}
