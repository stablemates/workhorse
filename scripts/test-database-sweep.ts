/**
 * Reclaim the test databases nothing owns any more.
 *
 * A database-scope test file creates a scratch database named after the checkout's test database
 * plus a per-process digest, and drops it in teardown. A teardown that times out never reaches
 * that drop, and removing the worktree takes its registry entry away, so `pnpm worktree:prune`
 * never sees the leftovers. Schema templates accumulate the same way: `copySchemaTemplate`
 * names one per schema digest and UTC day and keeps it on purpose, so every schema change and
 * every new day retires the previous one without removing it. Each worktree can be on a different
 * schema, so the sweep keeps the template of each worktree's current schema. A harness holds the
 * advisory lock of a database while it needs it, and the sweep skips a database whose lock is busy.
 *
 * Classification is positive. A database is retired only when its name matches the template shape
 * or the scratch shape of a known `_test` family; everything else is foreign and is never
 * touched. Kept free of `pg` at run time so the classification tests need no server.
 */
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { databaseErrorCode } from "../typescript/core/src/errors.js";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabasePurposes,
  localDatabaseUrl,
} from "../typescript/core/src/local-database.js";
import {
  schemaTemplateLockName,
  schemaTemplateName,
  schemaTemplatePrefix,
} from "../typescript/core/test/support/schema-template.js";
import { isMissing } from "./environment-file.js";

/** A scratch database ends in the per-process digest its harness appended. */
const scratchDigest = /^[0-9a-f]{10}$/;
const databaseObjectInUseCode = "55006";
/** `pg_database_size` of a dropped database: 42704 on PostgreSQL 18, 3D000 on older versions. */
const droppedDatabaseCodes = new Set(["42704", "3D000"]);

export type TestDatabaseKind = "scratch" | "template" | "registry" | "foreign";

export interface TestDatabaseClassification {
  kind: TestDatabaseKind;
  /** Whether nothing owns the name any more, so the sweep may drop it. */
  retired: boolean;
}

export interface SweepContext {
  /** Every database a checkout or a linked worktree owns by registry. Never swept. */
  protectedNames: ReadonlySet<string>;
  /** The `<prefix>_test` root each known test database shares with its scratch databases. */
  familyRoots: ReadonlySet<string>;
  /** The templates the `current.sql` of each worktree hashes to today, which its next run reuses. */
  liveTemplates: ReadonlySet<string>;
}

export interface DatabaseInventoryEntry {
  name: string;
  sizeBytes: number;
  /** Whether a backend is connected, which is the only evidence an owner is still alive. */
  inUse: boolean;
}

export interface SweepEntry extends DatabaseInventoryEntry {
  kind: TestDatabaseKind;
}

export interface SweepPlan {
  /** Retired databases with no connected backend. */
  drop: SweepEntry[];
  /** Retired databases a live session still holds, which the sweep leaves alone. */
  held: SweepEntry[];
}

export interface SweepOutcome {
  dropped: SweepEntry[];
  /** Entries a session or a harness lock claimed between planning and dropping. */
  skipped: SweepEntry[];
}

/**
 * Decide what a database name is. The order matters: a registry name wins over every shape, and
 * the template prefix wins over the scratch shape because a template name also ends in a digest.
 */
export function classifyTestDatabase(
  name: string,
  context: SweepContext,
): TestDatabaseClassification {
  if (context.protectedNames.has(name)) return { kind: "registry", retired: false };
  if (name.startsWith(schemaTemplatePrefix)) {
    return { kind: "template", retired: !context.liveTemplates.has(name) };
  }
  if (isScratchName(name, context.familyRoots)) return { kind: "scratch", retired: true };
  return { kind: "foreign", retired: false };
}

/**
 * The `<prefix>_test` roots a set of owned database names implies. A scratch database keeps the
 * root of the test database it was derived from, so the roots are what tells a leaked scratch
 * database of a removed worktree apart from a database of some other project on the same server.
 */
export function testFamilyRoots(names: Iterable<string>): Set<string> {
  const roots = new Set<string>();
  for (const name of names) {
    const match = name.match(/^(.*?_test)(?:_|$)/);
    if (match) roots.add(match[1]!);
  }
  return roots;
}

/** The five database names one environment owns, so the sweep can never classify them as scratch. */
export function checkoutDatabaseNames(environment: NodeJS.ProcessEnv): string[] {
  return localDatabasePurposes.map((purpose) =>
    databaseName(localDatabaseUrl(purpose, environment)),
  );
}

/** Every database name the linked worktree registries claim, including worktrees now removed. */
export async function registryDatabaseNames(commonGitDirectory: string): Promise<string[]> {
  const directory = join(commonGitDirectory, "worktree-resources");
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const names: string[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    const registry = JSON.parse(await readFile(join(directory, entry), "utf8")) as {
      databaseUrls?: Record<string, string>;
    };
    for (const databaseUrl of Object.values(registry.databaseUrls ?? {})) {
      names.push(databaseName(databaseUrl));
    }
  }
  return names;
}

/**
 * The template names the `current.sql` of each worktree of the repository gives today. A worktree
 * on a branch with a migration has a different schema digest, and its next test file copies that
 * template. A worktree without the file, such as one on an old commit, needs no template.
 */
export async function liveSchemaTemplates(
  worktreeRoots: Iterable<string>,
  now = new Date(),
): Promise<Set<string>> {
  const names = new Set<string>();
  for (const root of worktreeRoots) {
    let schema: Buffer;
    try {
      schema = await readFile(join(root, "sql/schema/current.sql"));
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    names.add(schemaTemplateName(schema, now));
  }
  return names;
}

/** The root of every worktree `git worktree list` reports, the primary checkout first. */
export function listWorktreeRoots(cwd: string): string[] {
  return parseWorktreeList(
    execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
}

/**
 * Read the roots from `git worktree list --porcelain -z`. Each field ends in a NUL character, so a
 * path that contains a newline stays whole.
 */
export function parseWorktreeList(listing: string): string[] {
  return listing
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
}

/**
 * Refuse the same targets `provisionCheckoutDatabases` and `dropWorktreeDatabases` refuse: a URL
 * whose database name has lost the test-purpose marker, and a server that is not this machine.
 */
export function assertSweepTarget(databaseUrl: string): void {
  assertLocalDatabasePurpose(databaseUrl, "test");
  const target = new URL(databaseUrl);
  if (!isLocalHost(target.hostname) && process.env.WORKHORSE_ALLOW_REMOTE_RESET !== "1") {
    throw new Error(`Refusing to sweep test databases on remote host ${target.hostname}`);
  }
}

/**
 * Read every connectable database with its size and whether a backend holds it.
 *
 * Other checkouts create and drop scratch databases on the same server all the time. A database
 * can disappear between the catalog read and its size read, and PostgreSQL then fails the size
 * read. So the size of each database is a separate query, and a database that is gone is left out.
 */
export async function readDatabaseInventory(
  admin: Pick<Pool, "query">,
): Promise<DatabaseInventoryEntry[]> {
  const result = await admin.query<{ oid: string; name: string; in_use: boolean }>(
    `SELECT database.oid::text AS oid,
            database.datname AS name,
            EXISTS (
              SELECT 1 FROM pg_stat_activity AS session WHERE session.datname = database.datname
            ) AS in_use
       FROM pg_database AS database
      WHERE NOT database.datistemplate
        AND database.datallowconn
      ORDER BY database.datname`,
  );
  const inventory: DatabaseInventoryEntry[] = [];
  for (const row of result.rows) {
    let size;
    try {
      size = await admin.query<{ size_bytes: string | null }>(
        "SELECT pg_database_size($1::oid)::text AS size_bytes",
        [row.oid],
      );
    } catch (error) {
      if (droppedDatabaseCodes.has(databaseErrorCode(error) ?? "")) continue;
      throw error;
    }
    const sizeBytes = size.rows[0]?.size_bytes;
    if (sizeBytes === null || sizeBytes === undefined) continue;
    inventory.push({ name: row.name, sizeBytes: Number(sizeBytes), inUse: row.in_use });
  }
  return inventory;
}

/** Split an inventory into what the sweep may drop and what a live session still holds. */
export function planTestDatabaseSweep(
  inventory: readonly DatabaseInventoryEntry[],
  context: SweepContext,
): SweepPlan {
  const plan: SweepPlan = { drop: [], held: [] };
  for (const entry of inventory) {
    const { kind, retired } = classifyTestDatabase(entry.name, context);
    if (!retired) continue;
    (entry.inUse ? plan.held : plan.drop).push({ ...entry, kind });
  }
  return plan;
}

/**
 * Drop the planned databases one at a time. The classification is checked again per name so a
 * caller cannot hand this function a plan the guards never saw, and a database a session claimed
 * since planning is reported rather than forced away from its owner.
 *
 * Before it drops a database, the sweep takes the database's advisory lock with no wait. A test
 * harness holds that lock in shared mode while it still needs the database. A busy lock thus means
 * a live owner, and the sweep skips the database. The TypeScript and Python harnesses hold the lock
 * of a shared template from the existence check until the copy ends. The JVM harness holds the
 * lock of its per-process template until the process drops it, because no session stays connected
 * to a template. One session holds the lock and runs the drop, because a session advisory lock
 * belongs to one connection.
 */
export async function dropRetiredDatabases(
  admin: Pool,
  plan: SweepPlan,
  context: SweepContext,
): Promise<SweepOutcome> {
  const outcome: SweepOutcome = { dropped: [], skipped: [] };
  const session = await admin.connect();
  try {
    for (const entry of plan.drop) {
      const { kind, retired } = classifyTestDatabase(entry.name, context);
      if (!retired) {
        throw new Error(
          `Refusing to drop ${entry.name}: no longer classified as a retired database`,
        );
      }
      const lockName = kind === "template" ? schemaTemplateLockName(entry.name) : entry.name;
      const dropped = await dropUnlockedDatabase(session, entry.name, lockName);
      (dropped ? outcome.dropped : outcome.skipped).push(entry);
    }
  } finally {
    session.release();
  }
  return outcome;
}

async function dropUnlockedDatabase(
  session: PoolClient,
  name: string,
  lockName: string,
): Promise<boolean> {
  const lock = await session.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
    [lockName],
  );
  if (!lock.rows[0]!.locked) return false;
  try {
    return await dropUnheldDatabase(session, name);
  } finally {
    await session.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockName]);
  }
}

async function dropUnheldDatabase(session: PoolClient, name: string): Promise<boolean> {
  try {
    await session.query(`DROP DATABASE IF EXISTS ${identifier(name)}`);
    return true;
  } catch (error) {
    if (databaseErrorCode(error) !== databaseObjectInUseCode) throw error;
    return false;
  }
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function isScratchName(name: string, familyRoots: ReadonlySet<string>): boolean {
  let belongsToFamily = false;
  for (const root of familyRoots) {
    if (!name.startsWith(`${root}_`)) continue;
    belongsToFamily = true;
    break;
  }
  if (!belongsToFamily) return false;

  const lastSeparator = name.lastIndexOf("_");
  return lastSeparator > 0 && scratchDigest.test(name.slice(lastSeparator + 1));
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
