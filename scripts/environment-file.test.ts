import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnvironment, updateEnvironment } from "./environment-file.js";

describe("parseEnvironment", () => {
  it("ends an unquoted value at an inline comment", () => {
    expect(parseEnvironment("FEATURE=true # enabled\n")).toEqual({ FEATURE: "true" });
  });

  it("ends a quoted value at its closing quote, before a comment that follows it", () => {
    expect(
      parseEnvironment(
        ['DOUBLE="a # b" # comment', "SINGLE='c # d' # comment", "BACKTICK=`e` # comment"].join(
          "\n",
        ),
      ),
    ).toEqual({ DOUBLE: "a # b", SINGLE: "c # d", BACKTICK: "e" });
  });

  it("reads exported, spaced, empty, commented, and CRLF lines", () => {
    expect(
      parseEnvironment(
        [
          "# a comment line",
          "export EXPORTED=1",
          "  SPACED = value  ",
          "EMPTY=",
          "not a variable",
          "CRLF=windows\r",
          "",
        ].join("\n"),
      ),
    ).toEqual({ EXPORTED: "1", SPACED: "value", EMPTY: "", CRLF: "windows" });
  });

  it("matches what node --env-file reads from the same file", async () => {
    const contents = [
      "WORKHORSE_ENV_FILE_UNQUOTED=postgres://localhost/workhorse_test # the test database",
      'WORKHORSE_ENV_FILE_QUOTED="postgres://localhost/workhorse_test" # quoted',
      'WORKHORSE_ENV_FILE_MULTILINE="first\nsecond"',
      "WORKHORSE_ENV_FILE_REPEATED=first",
      "WORKHORSE_ENV_FILE_REPEATED=last",
    ].join("\n");
    const expected = {
      WORKHORSE_ENV_FILE_UNQUOTED: "postgres://localhost/workhorse_test",
      WORKHORSE_ENV_FILE_QUOTED: "postgres://localhost/workhorse_test",
      WORKHORSE_ENV_FILE_MULTILINE: "first\nsecond",
      WORKHORSE_ENV_FILE_REPEATED: "last",
    };
    const directory = await mkdtemp(join(tmpdir(), "workhorse-env-file-"));
    try {
      const path = join(directory, ".env");
      await writeFile(path, contents);
      const read = execFileSync(
        process.execPath,
        [
          `--env-file=${path}`,
          "--eval",
          `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(
            Object.keys(expected),
          )}.map((key) => [key, process.env[key]]))))`,
        ],
        { encoding: "utf8" },
      );

      expect(parseEnvironment(contents)).toEqual(expected);
      expect(JSON.parse(read)).toEqual(expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("updateEnvironment", () => {
  it("rewrites existing keys in place and appends new ones", () => {
    const updated = updateEnvironment("# keep\nexport A=old # stale\nB=kept\n", {
      A: "new",
      C: "added",
    });

    expect(updated).toBe("# keep\nexport A=new\nB=kept\n\nC=added\n");
    expect(parseEnvironment(updated)).toEqual({ A: "new", B: "kept", C: "added" });
  });
});
