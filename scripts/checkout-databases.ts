import { Pool } from "pg";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseEnvironmentVariable,
  localDatabasePurposes,
  localDatabaseUrl,
  type LocalDatabasePurpose,
} from "../typescript/core/src/local-database.js";
import { installSchema } from "../typescript/core/src/schema.js";
import { isMissing, parseEnvironment, updateEnvironment } from "./environment-file.js";

export interface CheckoutDatabaseEnvironment {
  environment: Record<string, string>;
  addedVariables: string[];
}

export interface DatabaseProvisioningResult {
  purpose: LocalDatabasePurpose;
  database: string;
  action: "created" | "reset" | "unchanged";
}

/** Resolve every checkout-owned database variable from one canonical purpose list. */
export function checkoutDatabaseEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    localDatabasePurposes.map((purpose) => [
      localDatabaseEnvironmentVariable(purpose),
      localDatabaseUrl(purpose, environment),
    ]),
  );
}

/**
 * Write checkout-owned database URLs without making the primary checkout lose local overrides.
 * Linked worktree setup opts into replacement because its generated URLs are the isolation boundary.
 */
export async function writeCheckoutDatabaseEnvironment(
  checkoutRoot: string,
  options: {
    databaseEnvironment?: Record<string, string>;
    overwriteExisting?: boolean;
  } = {},
): Promise<CheckoutDatabaseEnvironment> {
  const targetPath = join(checkoutRoot, ".env");
  let contents: string;
  let targetExists = true;
  try {
    contents = await readFile(targetPath, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
    contents = await readFile(join(checkoutRoot, ".env.example"), "utf8");
    targetExists = false;
  }

  const sourceEnvironment = parseEnvironment(contents);
  const existingEnvironment = targetExists ? sourceEnvironment : {};
  const requestedEnvironment =
    options.databaseEnvironment ?? checkoutDatabaseEnvironment(sourceEnvironment);
  const addedVariables = Object.keys(requestedEnvironment).filter(
    (key) => existingEnvironment[key] === undefined,
  );
  const updates = options.overwriteExisting
    ? requestedEnvironment
    : Object.fromEntries(
        Object.entries(requestedEnvironment).filter(
          ([key]) => existingEnvironment[key] === undefined,
        ),
      );
  const updatedContents =
    targetExists && Object.keys(updates).length === 0
      ? contents
      : updateEnvironment(contents, updates);

  if (!targetExists || updatedContents !== contents) {
    await writeFile(targetPath, updatedContents, { mode: 0o600 });
  }
  await chmod(targetPath, 0o600);

  return {
    environment: parseEnvironment(updatedContents),
    addedVariables,
  };
}

/** Create absent checkout databases, or recreate all of them for isolated worktree setup. */
export async function provisionCheckoutDatabases(
  environment: NodeJS.ProcessEnv,
  options: { resetExisting?: boolean } = {},
): Promise<DatabaseProvisioningResult[]> {
  const results: DatabaseProvisioningResult[] = [];
  for (const purpose of localDatabasePurposes) {
    const databaseUrl = localDatabaseUrl(purpose, environment);
    assertLocalDatabasePurpose(databaseUrl, purpose);
    const target = new URL(databaseUrl);
    if (!isLocalHost(target.hostname) && process.env.WORKHORSE_ALLOW_REMOTE_RESET !== "1") {
      throw new Error(`Refusing to provision remote checkout database at ${target.hostname}`);
    }

    const name = databaseName(databaseUrl);
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    let exists: boolean;
    try {
      const existing = await admin.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
        [name],
      );
      exists = existing.rows[0]?.exists === true;
      if (exists && !options.resetExisting) {
        results.push({ purpose, database: name, action: "unchanged" });
        continue;
      }
      if (exists) await admin.query(`DROP DATABASE ${identifier(name)} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${identifier(name)}`);
    } finally {
      await admin.end();
    }

    const database = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await installSchema(database);
    } finally {
      await database.end();
    }
    results.push({ purpose, database: name, action: exists ? "reset" : "created" });
  }
  return results;
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
