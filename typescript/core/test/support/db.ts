import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, Pool, type PoolClient } from "pg";
import { dropLocalDatabase } from "../../src/drop-local-database.js";
import { installSchema } from "../../src/index.js";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseUrl,
  namedTestDatabaseUrl,
} from "../../src/local-database.js";
import {
  copySchemaTemplate,
  schemaTemplateName,
  scratchLeaseStatement,
  withoutWalFlushWait,
} from "./schema-template.js";

const schemaUrl = new URL("../../../../sql/schema/current.sql", import.meta.url);

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
    /**
     * Replaces the per-process digest with a fixed suffix, so a resource outside the test run —
     * a pooler's configured pool name, for example — can name the database ahead of time.
     */
    nameSuffix?: string;
    /** How long reset waits for its table locks before it fails. */
    resetLockWaitMs?: number;
  } = {},
): {
  databaseUrl: string;
  pool: Pool;
  setup: () => Promise<void>;
  /** Pass the hook's signal, so the reset stops its retries when the hook times out. */
  reset: (options?: { signal?: AbortSignal }) => Promise<void>;
  teardown: () => Promise<void>;
} {
  const sourceUrl = localDatabaseUrl("test");
  assertLocalDatabasePurpose(sourceUrl, "test");
  const isolatedUrl =
    options.nameSuffix === undefined
      ? isolatedDatabaseUrl(sourceUrl, fileUrl)
      : namedTestDatabaseUrl(sourceUrl, options.nameSuffix);
  const isolatedName = databaseName(isolatedUrl);
  const pool = new Pool({ connectionString: isolatedUrl, max: options.max });
  let lease: Client | undefined;

  return {
    databaseUrl: isolatedUrl,
    pool,
    async setup() {
      lease ??= await leaseScratchDatabase(isolatedUrl, isolatedName);
      if (options.schemaProvisioning === "install") {
        await recreateDatabase(isolatedUrl);
        await installSchema(pool);
        return;
      }

      await copyCurrentSchemaTemplate(sourceUrl, isolatedName);
      await prepareCurrentHistoryPartitions(pool);
    },
    async reset(resetOptions = {}) {
      resetOptions.signal?.throwIfAborted();
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
            "task_stat_state",
            "retention_policy",
          ],
        ],
      );
      await truncateWithoutDeadlock(pool, options.resetLockWaitMs ?? 30_000, resetOptions.signal, [
        ...(result.rows.length > 0
          ? [
              `TRUNCATE ${result.rows.map((row) => row.table_name).join(", ")} RESTART IDENTITY CASCADE`,
            ]
          : []),
        maintenanceStateReset,
      ]);
    },
    async teardown() {
      try {
        if (options.poolOwner !== "caller") await pool.end();
        await dropDatabase(isolatedUrl, isolatedName);
      } finally {
        // The lease ends after the drop. If the drop failed, the sweep can drop the database.
        await lease?.end();
        lease = undefined;
      }
    },
  };
}

/**
 * The reset keeps the maintenance_state rows, so this statement returns each column that a routine
 * writes to its install value. Otherwise a test inherits state from earlier tests in the file, for
 * example the tier order of terminal cleanup (SM-1717). A policy sync after the reset can also
 * write these rows. The forced syncs of createIntegrationTestContext keep the install values, and
 * integration-shared-reset.test.ts fails if they stop doing so.
 */
const maintenanceStateReset = `UPDATE workhorse.maintenance_state SET
  last_started_at = NULL,
  last_completed_at = NULL,
  last_completed_local_date = NULL,
  history_retained_before = CASE WHEN routine_name = 'history_retention'
    THEN date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      - interval '14 days'
    ELSE NULL END,
  terminal_prune_dependency_starved = false,
  terminal_prune_fast_first = false,
  terminal_cleanup_backlog_since = NULL,
  lease_recovery_started_at = NULL,
  updated_at = clock_timestamp()`;

/**
 * Run the statements of the reset, a TRUNCATE first, without a deadlock with a session that an
 * earlier test left.
 *
 * TRUNCATE takes an AccessExclusiveLock on each table in list order. A worker statement locks
 * `task` and `task_runtime` first, and an earlier table of that list after them. Thus the two
 * sessions can wait for each other (SM-1436). PostgreSQL looks for a deadlock only after
 * `deadlock_timeout`, and the lock wait of the reset ends before that. Then the reset releases its
 * locks, the other statement finishes, and the reset tries again. If the locks stay held, the
 * error names the sessions that hold them.
 *
 * If the hook that runs the reset times out, Vitest aborts the signal and starts the next test. The
 * reset then must not try again, because a retry in a later test can lock the tables that the test
 * uses. Each attempt ends its transaction before the reset checks the signal (SM-1679).
 */
async function truncateWithoutDeadlock(
  pool: Pool,
  lockWaitMs: number,
  signal: AbortSignal | undefined,
  statements: readonly string[],
): Promise<void> {
  const client = await pool.connect();
  try {
    const setting = await client.query<{ deadlock_timeout_ms: number }>(
      "SELECT setting::integer AS deadlock_timeout_ms FROM pg_settings WHERE name = 'deadlock_timeout'",
    );
    const deadlockTimeoutMs = setting.rows[0]!.deadlock_timeout_ms;
    const lockTimeoutMs = Math.max(1, Math.min(200, Math.floor(deadlockTimeoutMs / 5)));
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      signal?.throwIfAborted();
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
        for (const statement of statements) await client.query(statement);
        await client.query("COMMIT");
        return;
      } catch (error) {
        await client.query("ROLLBACK");
        // 55P03 is lock_not_available, the error of an expired lock_timeout.
        if ((error as { code?: string }).code !== "55P03") throw error;
        if (Date.now() >= deadline) {
          throw new Error(
            `The reset could not lock the tables within ${lockWaitMs} ms. ` +
              `A session from an earlier test still holds locks:\n${await lockHolders(client)}`,
            { cause: error },
          );
        }
      }
      await sleep(20);
    }
  } finally {
    client.release();
  }
}

async function lockHolders(client: PoolClient): Promise<string> {
  const holders = await client.query<{ pid: number; state: string | null; query: string }>(
    `SELECT activity.pid, activity.state, activity.query
       FROM pg_stat_activity AS activity
      WHERE activity.datname = current_database()
        AND activity.pid <> pg_backend_pid()
        AND EXISTS (
          SELECT 1
            FROM pg_locks AS lock
            JOIN pg_class AS relation ON relation.oid = lock.relation
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
           WHERE lock.pid = activity.pid
             AND lock.granted
             AND namespace.nspname <> 'pg_catalog'
        )
      ORDER BY activity.pid`,
  );
  if (holders.rows.length === 0) return "(no session holds a lock now)";
  return holders.rows
    .map((row) => `pid ${row.pid} (${row.state ?? "unknown"}): ${row.query}`)
    .join("\n");
}

/** Drop a scratch test database by name. The name must keep the test-purpose marker. */
export async function dropTestDatabase(sourceUrl: string, name: string): Promise<void> {
  await dropDatabase(sourceUrl, name);
}

/**
 * Create a database only if it is missing. Poolers hold server connections to configured
 * databases, so a scratch database behind a pooler must not be dropped out from under it. The
 * setting applies also to a database that an earlier run or the pooling fixture created.
 */
export async function ensureTestDatabase(sourceUrl: string, name: string): Promise<void> {
  const target = new URL(sourceUrl);
  target.pathname = `/${name}`;
  assertLocalDatabasePurpose(target.toString(), "test");
  const admin = adminPool(sourceUrl);
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${identifier(name)}`);
    await admin.query(withoutWalFlushWait(name));
  } finally {
    await admin.end();
  }
}

export { poolingScratchName } from "../../src/local-database.js";

async function prepareCurrentHistoryPartitions(pool: Pool): Promise<void> {
  await pool.query(
    `SELECT workhorse.create_history_day_v1(
              ((clock_timestamp() AT TIME ZONE 'UTC')::date + day_offset)::date
            )
       FROM generate_series(0, 3) AS days(day_offset)`,
  );
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
    await admin.query(withoutWalFlushWait(name));
  } finally {
    await admin.end();
  }
}

/**
 * Open the session that holds the lease of the scratch database `name` until the teardown. A
 * pooled client can close when it is idle and end its lock with it, so the lease is a client of
 * its own. If PostgreSQL ends the session, only the protection from the sweep ends, so its error
 * does not stop the test process.
 */
async function leaseScratchDatabase(databaseUrl: string, name: string): Promise<Client> {
  const lease = new Client({ connectionString: adminUrlFor(databaseUrl) });
  lease.on("error", () => {});
  await lease.connect();
  try {
    await lease.query(scratchLeaseStatement, [name]);
  } catch (error) {
    await lease.end();
    throw error;
  }
  return lease;
}

/**
 * Copy the template of the current schema into `targetName`. One checked-out client holds the
 * advisory locks, because a pool can close an idle client and end its session locks with it.
 */
async function copyCurrentSchemaTemplate(databaseUrl: string, targetName: string): Promise<void> {
  const templateName = schemaTemplateName(await readFile(schemaUrl));
  const admin = adminPool(databaseUrl);
  try {
    const session = await admin.connect();
    try {
      await copySchemaTemplate(session, {
        templateName,
        targetName,
        dropDatabase: (name) => dropLocalDatabase(session, name, { attempts: 40, retryMs: 25 }),
        async install(stagingName) {
          const stagingUrl = new URL(databaseUrl);
          stagingUrl.pathname = `/${stagingName}`;
          const staging = new Pool({ connectionString: stagingUrl.toString(), max: 1 });
          try {
            await installSchema(staging);
          } finally {
            await staging.end();
          }
        },
      });
    } finally {
      session.release();
    }
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
  await dropLocalDatabase(admin, name, { attempts: 40, retryMs: 25 });
}

function adminPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: adminUrlFor(databaseUrl), max: 1 });
}

function adminUrlFor(databaseUrl: string): string {
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
  return url.toString();
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
