import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { databaseErrorCode, installSchema } from "../../src/index.js";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseUrl,
} from "../../src/local-database.js";

const databaseDropAttempts = 40;
const databaseDropRetryMs = 25;
const databaseObjectInUseCode = "55006";

/**
 * Each test file gets a database derived from the checkout's guarded test URL. Separate databases
 * let files mutate the fixed `workhorse` schema without sharing state, and reset discovers tables
 * from PostgreSQL so adding a table to the schema does not require another cleanup-list edit.
 */
export function createDatabaseTestHarness(
  fileUrl: string,
  options: {
    max?: number;
    extraSchemas?: readonly string[];
    poolOwner?: "harness" | "caller";
  } = {},
): {
  databaseUrl: string;
  pool: Pool;
  setup: () => Promise<void>;
  reset: () => Promise<void>;
  teardown: () => Promise<void>;
} {
  const sourceUrl = localDatabaseUrl("test");
  assertLocalDatabasePurpose(sourceUrl, "test");
  const isolatedUrl = isolatedDatabaseUrl(sourceUrl, fileUrl);
  const isolatedName = databaseName(isolatedUrl);
  const pool = new Pool({ connectionString: isolatedUrl, max: options.max });

  return {
    databaseUrl: isolatedUrl,
    pool,
    async setup() {
      await recreateDatabase(isolatedUrl);
      await installSchema(pool);
    },
    async reset() {
      const schemas = ["workhorse", ...(options.extraSchemas ?? [])];
      const result = await pool.query<{ table_name: string }>(
        `SELECT format('%I.%I', namespace.nspname, relation.relname) AS table_name
           FROM pg_class AS relation
           JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = ANY($1::text[])
            AND relation.relkind IN ('r', 'p')
            AND NOT (
              namespace.nspname = 'workhorse'
              AND relation.relname = ANY($2::text[])
            )
            AND NOT EXISTS (
              SELECT 1 FROM pg_inherits WHERE inhrelid = relation.oid
            )
          ORDER BY namespace.nspname, relation.relname`,
        [
          schemas,
          [
            "schema_version",
            "schema_migration",
            "protocol_version",
            "maintenance_policy",
            "queue_health_policy",
            "maintenance_state",
            "job_stat_state",
            "retention_policy",
          ],
        ],
      );
      if (result.rows.length > 0) {
        await pool.query(
          `TRUNCATE ${result.rows.map((row) => row.table_name).join(", ")} RESTART IDENTITY CASCADE`,
        );
      }
    },
    async teardown() {
      if (options.poolOwner !== "caller") await pool.end();
      await dropDatabase(isolatedUrl, isolatedName);
    },
  };
}

function isolatedDatabaseUrl(sourceUrl: string, fileUrl: string): string {
  const url = new URL(sourceUrl);
  const sourceName = databaseName(sourceUrl);
  const digest = createHash("sha256")
    .update(`${fileUrl}\0${process.pid}`)
    .digest("hex")
    .slice(0, 10);
  url.pathname = `/${sourceName.slice(0, 52)}_${digest}`;
  return url.toString();
}

async function recreateDatabase(databaseUrl: string): Promise<void> {
  const name = databaseName(databaseUrl);
  const admin = adminPool(databaseUrl);
  try {
    await dropDatabaseWithAdmin(admin, name);
    await admin.query(`CREATE DATABASE ${identifier(name)}`);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(databaseUrl: string, name: string): Promise<void> {
  const admin = adminPool(databaseUrl);
  try {
    await dropDatabaseWithAdmin(admin, name);
  } finally {
    await admin.end();
  }
}

async function dropDatabaseWithAdmin(admin: Pool, name: string): Promise<void> {
  // FORCE signals every connected role, which the local test role cannot do. Terminate only
  // harness-owned sessions, then let short-lived foreign sessions finish before retrying.
  for (let attempt = 1; attempt <= databaseDropAttempts; attempt++) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${identifier(name)}`);
      return;
    } catch (error) {
      if (databaseErrorCode(error) !== databaseObjectInUseCode || attempt === databaseDropAttempts)
        throw error;
    }

    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1
          AND usename = current_user
          AND pid <> pg_backend_pid()`,
      [name],
    );
    await sleep(databaseDropRetryMs);
  }
}

function adminPool(databaseUrl: string): Pool {
  assertLocalDatabasePurpose(databaseUrl, "test");
  const url = new URL(databaseUrl);
  if (
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "::1" &&
    process.env.WORKHORSE_ALLOW_REMOTE_RESET !== "1"
  ) {
    throw new Error(
      "Refusing to manage a remote test database without WORKHORSE_ALLOW_REMOTE_RESET=1",
    );
  }
  url.pathname = "/postgres";
  return new Pool({ connectionString: url.toString(), max: 1 });
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
