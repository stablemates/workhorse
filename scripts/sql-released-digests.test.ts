import { cp, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DIGEST_FILE,
  RECORD_COMMAND,
  digestOf,
  findDigestProblems,
  formatDigestProblem,
  formatDigestRecord,
  parseDigestRecord,
  readDigestRecord,
  readSqlFiles,
  recordReleasedDigests,
} from "./sql-released-digests.js";

const repository = path.resolve(import.meta.dirname, "..");

/** A released migration of the 0.5.0 line whose backfill a database replays. */
const releasedMigration =
  "sql/migrations/0030-release-dependents-through-a-pending-prerequisite-counter.sql";

const scratchDirectories: string[] = [];

afterEach(async () => {
  for (const directory of scratchDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A copy of the repository's `sql/` tree, so a case can change a released file. */
async function copyOfSqlTree(): Promise<string> {
  const scratch = await mkdtemp(path.join(tmpdir(), "workhorse-released-digests-"));
  scratchDirectories.push(scratch);
  await cp(path.join(repository, "sql/migrations"), path.join(scratch, "sql/migrations"), {
    recursive: true,
  });
  await cp(path.join(repository, "sql/releases"), path.join(scratch, "sql/releases"), {
    recursive: true,
  });
  await cp(path.join(repository, DIGEST_FILE), path.join(scratch, DIGEST_FILE));
  return scratch;
}

async function problemsIn(scratch: string) {
  return findDigestProblems(await readSqlFiles(scratch), await readDigestRecord(scratch));
}

describe("released SQL digests", () => {
  it("matches every released file of the repository", async () => {
    const problems = findDigestProblems(
      await readSqlFiles(repository),
      await readDigestRecord(repository),
    );
    expect(problems.map(formatDigestProblem)).toEqual([]);
  });

  it("keeps the digest file in the form that the record command writes", async () => {
    const text = await readFile(path.join(repository, DIGEST_FILE), "utf8");
    expect(formatDigestRecord(parseDigestRecord(text))).toBe(text);
  });

  it("needs no digest for a migration above the newest release artifact", async () => {
    const scratch = await copyOfSqlTree();
    // A migration file far above the chain produces a schema version that no release shipped.
    await writeFile(path.join(scratch, "sql/migrations/9999-not-released.sql"), "SELECT 1;\n");

    const files = await readSqlFiles(scratch);
    expect(files.find((entry) => entry.file.endsWith("9999-not-released.sql"))?.released).toBe(
      false,
    );
    expect(files.find((entry) => entry.file === releasedMigration)?.released).toBe(true);
    expect(files.filter((entry) => entry.file.startsWith("sql/releases/"))).not.toContainEqual(
      expect.objectContaining({ released: false }),
    );
    expect(await problemsIn(scratch)).toEqual([]);
  });

  it("fails when the content of a released migration changes", async () => {
    const scratch = await copyOfSqlTree();
    const target = path.join(scratch, releasedMigration);
    const source = await readFile(target, "utf8");
    await writeFile(target, source.replace("UPDATE", "UPDATE /* changed backfill */"));

    expect(await problemsIn(scratch)).toEqual([{ kind: "changed", file: releasedMigration }]);
  });

  it("fails when a released artifact changes by one byte", async () => {
    const scratch = await copyOfSqlTree();
    const target = path.join(scratch, "sql/releases/0091.sql");
    await writeFile(target, `${await readFile(target, "utf8")}\n`);

    expect(await problemsIn(scratch)).toEqual([{ kind: "changed", file: "sql/releases/0091.sql" }]);
  });

  it("fails when a released file is deleted", async () => {
    const scratch = await copyOfSqlTree();
    await unlink(path.join(scratch, releasedMigration));

    expect(await problemsIn(scratch)).toEqual([{ kind: "missing", file: releasedMigration }]);
  });

  it("fails when a released file is renamed", async () => {
    const scratch = await copyOfSqlTree();
    const renamed = "sql/migrations/0030-renamed.sql";
    await rename(path.join(scratch, releasedMigration), path.join(scratch, renamed));

    expect(await problemsIn(scratch)).toEqual([
      { kind: "missing", file: releasedMigration },
      { kind: "unrecorded", file: renamed },
    ]);
  });

  it("names the record command when a new release artifact has no digest", async () => {
    const scratch = await copyOfSqlTree();
    // A release artifact far above the chain marks every migration as released.
    await writeFile(path.join(scratch, "sql/releases/9999.sql"), "SELECT 1;\n");

    const problems = await problemsIn(scratch);
    expect(problems).toContainEqual({ kind: "unrecorded", file: "sql/releases/9999.sql" });
    expect(problems.every((problem) => problem.kind === "unrecorded")).toBe(true);
    expect(formatDigestProblem({ kind: "unrecorded", file: "sql/releases/9999.sql" })).toContain(
      RECORD_COMMAND,
    );

    const recorded = recordReleasedDigests(
      await readSqlFiles(scratch),
      await readDigestRecord(scratch),
    );
    expect(recorded.get("sql/releases/9999.sql")).toBe(digestOf("SELECT 1;\n"));
    expect(findDigestProblems(await readSqlFiles(scratch), recorded)).toEqual([]);
  });

  it("refuses to record over a released file whose content changed", async () => {
    const scratch = await copyOfSqlTree();
    const target = path.join(scratch, releasedMigration);
    await writeFile(target, `${await readFile(target, "utf8")}-- changed\n`);

    await expect(
      (async () =>
        recordReleasedDigests(await readSqlFiles(scratch), await readDigestRecord(scratch)))(),
    ).rejects.toThrow(`${releasedMigration} is released, but its content changed`);
  });

  it("rejects a digest file entry that is not a SHA-256 digest", () => {
    expect(() => parseDigestRecord('{"sql/releases/0091.sql": "abc"}')).toThrow(
      "has no lowercase hexadecimal SHA-256 digest",
    );
    expect(() => parseDigestRecord("[]")).toThrow("must hold one JSON object");
  });
});
