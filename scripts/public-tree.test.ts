import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const forbiddenFragments = [
  {
    label: "private deployment host",
    value: ["ol", "di"].join(""),
    word: true,
  },
  {
    label: "private operator username",
    value: ["an", "ton"].join(""),
    word: true,
  },
  {
    label: "private registry address",
    value: ["192", "168", "1", "67"].join("."),
    word: false,
  },
  {
    label: "private host filesystem",
    value: ["/mnt", "/extra/"].join(""),
    word: false,
  },
  {
    label: "private registry credential variable",
    value: ["KAMAL", "REGISTRY", "PASSWORD"].join("_"),
    word: false,
  },
  {
    label: "production database target",
    value: ["workhorse@", "workhorse_demo"].join(""),
    word: false,
  },
  {
    label: "production database recovery option",
    value: ["--recreate", "-demo-database"].join(""),
    word: false,
  },
  {
    label: "destructive production database command",
    value: ["drop", "db --force"].join(""),
    word: false,
  },
] as const;

const homeDirectoryPattern = new RegExp(`/(?:${["ho", "me"].join("")}|Users)/[^/\\s"']+/`);

async function publicTextFiles() {
  const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "-z"], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean);
}

describe("public repository hygiene", () => {
  it("contains no private deployment topology or developer home paths", async () => {
    const findings: string[] = [];

    for (const path of await publicTextFiles()) {
      let contents: Buffer;
      try {
        contents = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (contents.includes(0)) continue;

      const text = contents.toString("utf8");
      if (homeDirectoryPattern.test(text)) findings.push(`developer home path in ${path}`);

      for (const fragment of forbiddenFragments) {
        const found = fragment.word
          ? new RegExp(`\\b${fragment.value}\\b`).test(text)
          : text.includes(fragment.value);
        if (found) findings.push(`${fragment.label} in ${path}`);
      }
    }

    expect(findings).toEqual([]);
  });
});
