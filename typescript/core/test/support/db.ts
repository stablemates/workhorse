import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
const schemaTemplatePrefix = "workhorse_test_template_";
const schemaUrl = new URL("../../../../sql/schema.sql", import.meta.url);

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
    schemaProvisioning?: "install" | "template";
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
      if (options.schemaProvisioning === "install") {
        await recreateDatabase(isolatedUrl);
        await installSchema(pool);
        return;
      }

      const templateName = await ensureSchemaTemplate(sourceUrl);
      await recreateDatabase(isolatedUrl, templateName);
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

async function recreateDatabase(databaseUrl: string, templateName?: string): Promise<void> {
  const name = databaseName(databaseUrl);
  const admin = adminPool(databaseUrl);
  try {
    await dropDatabaseWithAdmin(admin, name);
    await admin.query(
      templateName === undefined
        ? `CREATE DATABASE ${identifier(name)}`
        : `CREATE DATABASE ${identifier(name)} TEMPLATE ${identifier(templateName)}`,
    );
  } finally {
    await admin.end();
  }
}

async function ensureSchemaTemplate(databaseUrl: string): Promise<string> {
  const schema = await readFile(schemaUrl);
  const templateName = `${schemaTemplatePrefix}${createHash("sha256").update(schema).digest("hex").slice(0, 16)}`;
  const stagingName = `${templateName}_building`;
  const admin = adminPool(databaseUrl);
  let locked = false;

  try {
    await admin.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [templateName]);
    locked = true;
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      templateName,
    ]);
    if (existing.rowCount !== 0) return templateName;

    await dropDatabaseWithAdmin(admin, stagingName);
    await admin.query(`CREATE DATABASE ${identifier(stagingName)}`);
    const stagingUrl = new URL(databaseUrl);
    stagingUrl.pathname = `/${stagingName}`;
    const staging = new Pool({ connectionString: stagingUrl.toString(), max: 1 });
    try {
      await installSchema(staging);
    } catch (error) {
      await staging.end();
      await dropDatabaseWithAdmin(admin, stagingName);
      throw error;
    }
    await staging.end();
    await admin.query(
      `ALTER DATABASE ${identifier(stagingName)} RENAME TO ${identifier(templateName)}`,
    );
    return templateName;
  } finally {
    if (locked)
      await admin.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [templateName]);
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
