/**
 * Refuse a change to the content of a released migration or a released clean-install artifact.
 *
 * `sql/README.md` and `docs/schema-lifecycle.md` make every released file immutable: a database that
 * migrates through a step must get the result of the release that shipped the step. The signature
 * check in `scripts/sql-released-signatures.ts` allows a changed function body, and the schema test
 * compares only the shape, so neither finds a changed backfill. This check compares the SHA-256 of
 * each released file with the digest that `sql/released-digests.json` records.
 *
 * A file is released when a release shipped it:
 *
 * - Every `sql/releases/<NNNN>.sql` artifact is released.
 * - A migration in `sql/migrations/` is released when the schema version it produces is at most the
 *   version of the newest artifact. A migration above that version is not released yet, so it needs
 *   no digest.
 *
 * Run `pnpm --silent exec tsx scripts/sql-released-digests.ts --record` after you freeze the
 * artifact of a new release. The command adds the digests of the files that the release ships. It
 * refuses to change a digest that is already recorded.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SCHEMA_MIGRATIONS } from "../typescript/core/src/schema.js";

/** The committed file of recorded digests, relative to the repository root. */
export const DIGEST_FILE = "sql/released-digests.json";

/** The command that records the digests of a new release. A failure message names it. */
export const RECORD_COMMAND = "pnpm --silent exec tsx scripts/sql-released-digests.ts --record";

/** The SHA-256 of each released file, keyed by its path relative to the repository root. */
export type DigestRecord = ReadonlyMap<string, string>;

/** One SQL file of the `sql/` tree, with the digest of its content. */
export interface SqlFile {
  /** The path relative to the repository root, for example `sql/releases/0091.sql`. */
  readonly file: string;
  /** The lowercase hexadecimal SHA-256 of the file's bytes. */
  readonly digest: string;
  /** Whether a published release shipped the file. */
  readonly released: boolean;
}

const sha256 = /^[0-9a-f]{64}$/;

/** The lowercase hexadecimal SHA-256 of `content`. */
export function digestOf(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The schema version a migration produces. A file number can run ahead of its version, because a
 * reserved number still steps the version by one, so the version comes from the migration chain.
 */
function migrationVersion(name: string): number {
  const step = SCHEMA_MIGRATIONS.find((candidate) => candidate.file === name);
  return step?.toVersion ?? Number.parseInt(name, 10);
}

/** Read every artifact and migration of `repository`, and mark the files that a release shipped. */
export async function readSqlFiles(repository: string): Promise<SqlFile[]> {
  const sqlNames = async (directory: string) =>
    (await readdir(path.join(repository, directory)))
      .filter((name) => name.endsWith(".sql"))
      .toSorted();
  const digestAt = async (file: string) => digestOf(await readFile(path.join(repository, file)));

  const artifacts = await sqlNames("sql/releases");
  const newestRelease = Math.max(0, ...artifacts.map((name) => Number.parseInt(name, 10)));
  const files: SqlFile[] = [];
  for (const name of artifacts) {
    const file = `sql/releases/${name}`;
    files.push({ file, digest: await digestAt(file), released: true });
  }
  for (const name of await sqlNames("sql/migrations")) {
    const file = `sql/migrations/${name}`;
    files.push({
      file,
      digest: await digestAt(file),
      released: migrationVersion(name) <= newestRelease,
    });
  }
  return files;
}

/** Parse the text of the digest file. A malformed file is an error, never an empty record. */
export function parseDigestRecord(text: string): DigestRecord {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${DIGEST_FILE} must hold one JSON object of file paths and digests`);
  }
  const record = new Map<string, string>();
  for (const [file, digest] of Object.entries(parsed)) {
    if (typeof digest !== "string" || !sha256.test(digest)) {
      throw new Error(`${DIGEST_FILE}: ${file} has no lowercase hexadecimal SHA-256 digest`);
    }
    record.set(file, digest);
  }
  return record;
}

/** The text of the digest file for `record`: sorted keys, two-space indent, a final newline. */
export function formatDigestRecord(record: DigestRecord): string {
  const sorted = Object.fromEntries(
    [...record].toSorted(([left], [right]) => left.localeCompare(right)),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * One way the released files disagree with the record. `changed` and `missing` name a recorded
 * file. `unrecorded` names a released file that has no digest yet.
 */
export interface DigestProblem {
  readonly kind: "changed" | "missing" | "unrecorded";
  readonly file: string;
}

/**
 * Each problem of the released files against `record`. A recorded file must exist and keep its
 * digest, so a change, a deletion, and a rename each fail. A released file must have a digest.
 */
export function findDigestProblems(
  files: readonly SqlFile[],
  record: DigestRecord,
): DigestProblem[] {
  const problems: DigestProblem[] = [];
  const present = new Map(files.map((entry) => [entry.file, entry]));
  for (const [file, digest] of record) {
    const entry = present.get(file);
    if (entry === undefined) problems.push({ kind: "missing", file });
    else if (entry.digest !== digest) problems.push({ kind: "changed", file });
  }
  for (const entry of files) {
    if (entry.released && !record.has(entry.file)) {
      problems.push({ kind: "unrecorded", file: entry.file });
    }
  }
  return problems;
}

/** The sentence a reader of the failure gets for `problem`. */
export function formatDigestProblem(problem: DigestProblem): string {
  switch (problem.kind) {
    case "missing":
      return `${problem.file} is released, but the file is missing. Restore it. A released file is never deleted or renamed.`;
    case "changed":
      return `${problem.file} is released, but its content changed. Restore it, and ship the correction as a new migration.`;
    case "unrecorded":
      return `${problem.file} is released, but ${DIGEST_FILE} records no digest for it. Run \`${RECORD_COMMAND}\`.`;
    default: {
      const exhaustive: never = problem.kind;
      return exhaustive;
    }
  }
}

/**
 * The record with a digest for each released file that has none. The function refuses when a
 * recorded file changed or is missing, so the command cannot hide a change to a released file.
 */
export function recordReleasedDigests(
  files: readonly SqlFile[],
  record: DigestRecord,
): DigestRecord {
  const problems = findDigestProblems(files, record);
  const blocking = problems.filter((problem) => problem.kind !== "unrecorded");
  if (blocking.length > 0) throw new Error(blocking.map(formatDigestProblem).join("\n"));
  const next = new Map(record);
  const digests = new Map(files.map((entry) => [entry.file, entry.digest]));
  for (const problem of problems) {
    const digest = digests.get(problem.file);
    if (digest !== undefined) next.set(problem.file, digest);
  }
  return next;
}

/** Read the committed digest file of `repository`. */
export async function readDigestRecord(repository: string): Promise<DigestRecord> {
  return parseDigestRecord(await readFile(path.join(repository, DIGEST_FILE), "utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const repository = path.resolve(import.meta.dirname, "..");
  const flags = process.argv.slice(2);
  try {
    if (flags.length > 1 || (flags.length === 1 && flags[0] !== "--record")) {
      throw new Error("Usage: tsx scripts/sql-released-digests.ts [--record]");
    }
    const files = await readSqlFiles(repository);
    const record = await readDigestRecord(repository);
    if (flags[0] === "--record") {
      const next = recordReleasedDigests(files, record);
      await writeFile(path.join(repository, DIGEST_FILE), formatDigestRecord(next));
      process.stdout.write(`Recorded ${next.size - record.size} new digest(s) in ${DIGEST_FILE}\n`);
    } else {
      const problems = findDigestProblems(files, record);
      if (problems.length > 0) throw new Error(problems.map(formatDigestProblem).join("\n"));
      process.stdout.write(`${record.size} released file(s) match ${DIGEST_FILE}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
