import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withoutDirectoryEntries } from "./zip-directory-entries.js";

const endLength = 22;

const files: Record<string, string> = {
  "go.mod": "module example.com/m\n\ngo 1.26\n",
  "a/b/c.go": "package b\n\n" + "// deflate me\n".repeat(400),
  "a/empty.txt": "",
  "z/README.md": "readme\n",
};

interface LocalRecord {
  offset: number;
  name: string;
  contents: Buffer;
}

/**
 * Walk the local headers from the start of the archive, independently of the central directory
 * that the function under test reads, and decode each file.
 */
function readLocalRecords(archive: Buffer): LocalRecord[] {
  const records: LocalRecord[] = [];
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const flags = archive.readUInt16LE(offset + 6);
    expect(flags & 0x08).toBe(0);
    const method = archive.readUInt16LE(offset + 8);
    const crc = archive.readUInt32LE(offset + 14);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const name = archive.toString("utf8", offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    const contents = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    expect(crc32(contents) >>> 0).toBe(crc);
    records.push({ offset, name, contents });
    offset = dataStart + compressedSize;
  }
  expect(archive.readUInt32LE(offset)).toBe(0x02014b50);
  return records;
}

function readCentralDirectory(archive: Buffer): { name: string; offset: number }[] {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  expect(cursor + archive.readUInt32LE(end + 12)).toBe(end);
  const entries: { name: string; offset: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50);
    const nameLength = archive.readUInt16LE(cursor + 28);
    entries.push({
      name: archive.toString("utf8", cursor + 46, cursor + 46 + nameLength),
      offset: archive.readUInt32LE(cursor + 42),
    });
    cursor +=
      46 + nameLength + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
  }
  return entries;
}

describe("withoutDirectoryEntries", () => {
  let scratch: string;
  let archive: Buffer;
  const prefix = "example.com/m@v1.0.0/";

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "workhorse-zip-"));
    const repository = join(scratch, "repository");
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(dirname(join(repository, name)), { recursive: true });
      await writeFile(join(repository, name), contents);
    }
    // A git hook exports `GIT_DIR`, `GIT_INDEX_FILE`, and other `GIT_*` variables. If they reached
    // these commands, `git init` would make the repository of the hook bare, and `git commit` would
    // commit the fixture to its branch.
    const git = (...arguments_: string[]) =>
      execFileSync("git", ["-C", repository, ...arguments_], {
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
          ),
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      });
    git("init", "--quiet");
    const gitDirectory = git("rev-parse", "--absolute-git-dir").toString().trim();
    if (gitDirectory !== join(await realpath(repository), ".git")) {
      throw new Error(`The fixture commands use the repository at ${gitDirectory}.`);
    }
    git("add", ".");
    git("commit", "--quiet", "--message", "fixture");
    const output = join(scratch, "module.zip");
    git("archive", "--format=zip", `--prefix=${prefix}`, "--output", output, "HEAD");
    archive = await readFile(output);
  });

  afterAll(async () => {
    await rm(scratch, { force: true, recursive: true });
  });

  it("starts from a git archive that has directory entries", () => {
    expect(readCentralDirectory(archive).map((entry) => entry.name)).toEqual(
      expect.arrayContaining([prefix, `${prefix}a/`, `${prefix}a/b/`, `${prefix}z/`]),
    );
  });

  it("keeps every file and removes every directory entry", () => {
    const rewritten = withoutDirectoryEntries(archive);
    const local = readLocalRecords(rewritten);
    const central = readCentralDirectory(rewritten);

    const expected = Object.keys(files)
      .map((name) => `${prefix}${name}`)
      .toSorted();
    expect(local.map((record) => record.name).toSorted()).toEqual(expected);
    expect(central.map((entry) => entry.name).toSorted()).toEqual(expected);
    expect(central).toEqual(
      expect.arrayContaining(local.map(({ name, offset }) => ({ name, offset }))),
    );
    for (const record of local) {
      expect(record.contents.toString("utf8")).toBe(files[record.name.slice(prefix.length)]);
    }
  });

  it("returns an archive without directory entries unchanged", () => {
    const rewritten = withoutDirectoryEntries(archive);
    expect(withoutDirectoryEntries(rewritten).equals(rewritten)).toBe(true);
  });

  it("keeps an archive comment that holds bytes like an end record", () => {
    // The comment is an empty end record, which is a valid comment.
    const comment = Buffer.alloc(22);
    comment.writeUInt32LE(0x06054b50, 0);
    const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    // `git archive` of a commit writes the commit ID as the comment. The test replaces it.
    const endRecord = Buffer.from(archive.subarray(end, end + endLength));
    endRecord.writeUInt16LE(comment.length, 20);
    const commented = Buffer.concat([archive.subarray(0, end), endRecord, comment]);

    const rewritten = withoutDirectoryEntries(commented);

    expect(rewritten.subarray(-comment.length).equals(comment)).toBe(true);
    // The records and the central directory are the same as without the comment.
    const withoutComment = withoutDirectoryEntries(archive);
    const body = withoutComment.length - endLength - archive.readUInt16LE(end + 20);
    expect(rewritten.length).toBe(body + endLength + comment.length);
    expect(rewritten.subarray(0, body).equals(withoutComment.subarray(0, body))).toBe(true);
  });

  it("refuses bytes that are not a zip archive", () => {
    expect(() => withoutDirectoryEntries(Buffer.from("not a zip archive at all"))).toThrow(
      "no zip end of central directory record",
    );
  });
});
