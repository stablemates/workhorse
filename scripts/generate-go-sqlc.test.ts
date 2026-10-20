import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";

import { compareGenerated, loadVerifiedArchive } from "./generate-go-sqlc.js";

it("detects changed, missing, and unexpected generated files without rewriting them", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "sqlc-drift-test-"));
  try {
    const actual = path.join(temporary, "actual");
    const expected = path.join(temporary, "expected");
    await mkdir(actual);
    await mkdir(expected);
    await writeFile(path.join(actual, "db.go"), "same");
    await writeFile(path.join(expected, "db.go"), "same");
    expect(await compareGenerated(actual, expected)).toEqual([]);
    await writeFile(path.join(expected, "db.go"), "changed");
    await writeFile(path.join(actual, "missing.go"), "missing");
    await writeFile(path.join(expected, "unexpected.go"), "unexpected");
    expect(await compareGenerated(actual, expected)).toEqual([
      "db.go",
      "missing.go",
      "unexpected.go",
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it("keeps the shared sqlc archive whole while concurrent runs load it", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "sqlc-archive-test-"));
  try {
    const archive = randomBytes(8 * 1024 * 1024);
    const digest = createHash("sha256").update(archive).digest("hex");
    const archivePath = path.join(temporary, "cache", "sqlc.tar.gz");
    let downloads = 0;
    const download = async () => {
      downloads += 1;
      await sleep(5);
      return Buffer.from(archive);
    };
    const reading = { active: true };
    const observed: number[] = [];
    const reader = (async () => {
      while (reading.active) {
        try {
          observed.push((await readFile(archivePath)).length);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await nextTurn();
      }
    })();
    const loaded = await Promise.all(
      Array.from({ length: 4 }, () => loadVerifiedArchive(archivePath, digest, download)),
    ).finally(() => {
      reading.active = false;
    });
    await reader;
    for (const result of loaded) expect(result.equals(archive)).toBe(true);
    expect(observed.every((length) => length === archive.length)).toBe(true);
    expect((await readFile(archivePath)).equals(archive)).toBe(true);
    expect(await readdir(path.dirname(archivePath))).toEqual(["sqlc.tar.gz"]);

    const before = await stat(archivePath);
    const again = await Promise.all(
      Array.from({ length: 4 }, () => loadVerifiedArchive(archivePath, digest, download)),
    );
    for (const result of again) expect(result.equals(archive)).toBe(true);
    const after = await stat(archivePath);
    expect(downloads).toBe(4);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it("replaces a damaged cached sqlc archive and rejects a download with the wrong checksum", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "sqlc-archive-test-"));
  try {
    const archive = randomBytes(1024);
    const digest = createHash("sha256").update(archive).digest("hex");
    const archivePath = path.join(temporary, "sqlc.tar.gz");
    await writeFile(archivePath, archive.subarray(0, 100));
    const loaded = await loadVerifiedArchive(archivePath, digest, async () => Buffer.from(archive));
    expect(loaded.equals(archive)).toBe(true);
    expect((await readFile(archivePath)).equals(archive)).toBe(true);

    await rm(archivePath);
    await expect(
      loadVerifiedArchive(archivePath, digest, async () => randomBytes(1024)),
    ).rejects.toThrow("checksum mismatch");
    expect(await readdir(temporary)).toEqual([]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
