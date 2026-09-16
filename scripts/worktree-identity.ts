/**
 * Tell a linked worktree apart from the primary checkout, and check that the databases its `.env`
 * names belong to it.
 *
 * Kept free of `pg` and of child processes so that `with-env.ts`, which runs ahead of every
 * repository command, can afford the check.
 */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  databaseName,
  isWorktreeDatabaseUrl,
  localDatabaseEnvironmentVariable,
  localDatabasePurposes,
} from "../typescript/core/src/local-database.js";
import { isMissing } from "./environment-file.js";

/**
 * The worktree id Git assigned to a linked worktree, or undefined for the primary checkout. A
 * linked worktree's `.git` is a file pointing at `<common>/worktrees/<id>`; the primary's is a
 * directory.
 */
export async function linkedWorktreeId(checkoutRoot: string): Promise<string | undefined> {
  let pointer: string;
  try {
    pointer = await readFile(join(checkoutRoot, ".git"), "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EISDIR")
      return undefined;
    throw error;
  }
  const match = pointer.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) return undefined;
  return basename(match[1]!);
}

export interface UnscopedDatabase {
  variable: string;
  database: string | undefined;
}

/**
 * The repository-owned database variables that do not name a database of this worktree: absent
 * ones, the primary checkout's names, and another worktree's names alike. Empty means the
 * worktree can run database-scope commands without touching another checkout's data.
 */
export function unscopedDatabases(
  environment: NodeJS.ProcessEnv,
  worktreeId: string,
): UnscopedDatabase[] {
  const unscoped: UnscopedDatabase[] = [];
  for (const purpose of localDatabasePurposes) {
    const variable = localDatabaseEnvironmentVariable(purpose);
    const databaseUrl = environment[variable];
    if (databaseUrl !== undefined && isWorktreeDatabaseUrl(databaseUrl, purpose, worktreeId)) {
      continue;
    }
    unscoped.push({ variable, database: databaseUrl && safeDatabaseName(databaseUrl) });
  }
  return unscoped;
}

/** Explain a refusal so the reader knows which checkout would have been hit and what to run. */
export function describeUnscopedDatabases(
  worktreeId: string,
  checkoutRoot: string,
  unscoped: UnscopedDatabase[],
): string {
  const details = unscoped
    .map(({ variable, database }) => `${variable} → ${database ?? "(unset)"}`)
    .join(", ");
  return [
    `Linked worktree ${worktreeId} does not own its databases: ${details}.`,
    "Database-scope commands would read and reset another checkout's data.",
    `Run \`pnpm worktree:setup\` in ${checkoutRoot} to provision databases for this worktree.`,
  ].join("\n");
}

function safeDatabaseName(databaseUrl: string): string {
  try {
    return databaseName(databaseUrl);
  } catch {
    return databaseUrl;
  }
}
