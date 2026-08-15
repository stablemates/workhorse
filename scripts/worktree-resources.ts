import { execFileSync, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Pool } from "pg";
import { isMissing } from "./environment-file.js";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseEnvironmentVariable,
  localDatabasePurposes,
  localDatabaseUrl,
  type LocalDatabasePurpose,
  worktreeDatabaseUrl,
} from "../typescript/core/src/local-database.js";

export { parseEnvironment, readEnvironment, updateEnvironment } from "./environment-file.js";

export interface WorktreeResources {
  version: 1;
  worktreeId: string;
  worktreeRoot: string;
  gitDirectory: string;
  databaseUrls: Record<LocalDatabasePurpose, string>;
}

export function git(cwd: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

export function worktreeContext(cwd = process.cwd()) {
  const worktreeRoot = git(cwd, "rev-parse", "--show-toplevel");
  const gitDirectory = git(cwd, "rev-parse", "--path-format=absolute", "--git-dir");
  const commonGitDirectory = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const primaryWorktreeRoot = dirname(commonGitDirectory);
  const linked = resolve(gitDirectory) !== resolve(commonGitDirectory);

  return {
    linked,
    worktreeRoot,
    gitDirectory,
    commonGitDirectory,
    primaryWorktreeRoot,
    worktreeId: basename(gitDirectory),
  };
}

export function resourceRegistryPath(commonGitDirectory: string, worktreeId: string): string {
  return join(commonGitDirectory, "worktree-resources", `${worktreeId}.json`);
}

export async function copyIgnoredEnvironmentFiles(
  sourceRoot: string,
  targetRoot: string,
): Promise<string[]> {
  const copied: string[] = [];
  for (const source of await findEnvironmentFiles(sourceRoot)) {
    const relativePath = relative(sourceRoot, source);
    const target = join(targetRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, 0o600);
    copied.push(relativePath);
  }
  return copied;
}

export function createWorktreeResources(
  worktreeId: string,
  worktreeRoot: string,
  gitDirectory: string,
  environment: NodeJS.ProcessEnv,
): WorktreeResources {
  const databaseUrls = Object.fromEntries(
    localDatabasePurposes.map((purpose) => [
      purpose,
      worktreeDatabaseUrl(localDatabaseUrl(purpose, environment), purpose, worktreeId),
    ]),
  ) as Record<LocalDatabasePurpose, string>;

  return { version: 1, worktreeId, worktreeRoot, gitDirectory, databaseUrls };
}

export function resourceEnvironment(resources: WorktreeResources): Record<string, string> {
  return {
    DATABASE_URL: resources.databaseUrls.dev,
    ...Object.fromEntries(
      localDatabasePurposes.map((purpose) => [
        localDatabaseEnvironmentVariable(purpose),
        resources.databaseUrls[purpose],
      ]),
    ),
  };
}

export async function writeResourceRegistry(
  commonGitDirectory: string,
  resources: WorktreeResources,
): Promise<void> {
  const path = resourceRegistryPath(commonGitDirectory, resources.worktreeId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(resources, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readResourceRegistry(path: string): Promise<WorktreeResources> {
  return JSON.parse(await readFile(path, "utf8")) as WorktreeResources;
}

export async function dropWorktreeDatabases(resources: WorktreeResources): Promise<void> {
  for (const purpose of localDatabasePurposes) {
    const databaseUrl = resources.databaseUrls[purpose];
    assertLocalDatabasePurpose(databaseUrl, purpose);
    const target = new URL(databaseUrl);
    if (!isLocalHost(target.hostname) && process.env.WORKHORSE_ALLOW_REMOTE_RESET !== "1") {
      throw new Error(`Refusing to drop remote worktree database at ${target.hostname}`);
    }

    const name = databaseName(databaseUrl);
    if (
      !name.includes(`_${purpose}_`) ||
      !name.endsWith(`_${worktreeHash(resources.worktreeId)}`)
    ) {
      throw new Error(`Refusing to drop database without the expected worktree marker: ${name}`);
    }

    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = "/postgres";
    const pool = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    try {
      await pool.query(`DROP DATABASE IF EXISTS ${identifier(name)} WITH (FORCE)`);
      console.log(`Dropped worktree ${purpose} database ${name}`);
    } finally {
      await pool.end();
    }
  }
}

export async function removeResourceRegistry(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function run(
  command: string,
  arguments_: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  const child = spawn(command, arguments_, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  if (exitCode !== 0)
    throw new Error(`${command} ${arguments_.join(" ")} exited with code ${exitCode}`);
}

async function findEnvironmentFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const excludedDirectories = new Set([
    ".git",
    "node_modules",
    "dist",
    "coverage",
    ".turbo",
    ".cache",
  ]);

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) await visit(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !isLocalEnvironmentFile(entry.name)) continue;
      files.push(join(directory, entry.name));
    }
  }

  await visit(root);
  return files;
}

function isLocalEnvironmentFile(name: string): boolean {
  if (name.endsWith(".example")) return false;
  return name === ".env" || name.startsWith(".env.");
}

function worktreeHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
