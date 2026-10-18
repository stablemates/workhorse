import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { snapshotDrift, type SnapshotContract } from "./api-snapshot.js";
import { javaContract, kotlinContract } from "./jvm-api.js";
import { repositoryRoot } from "./packages.js";

// `java-api:check` and `kotlin-api:check` compare a fresh reading of the JVM artifacts with the
// committed snapshot. These cases start from the committed file and change the fresh reading the
// way a code change would. `jvm/api-snapshot` has its own tests that a changed declaration changes
// its line, so together they show that each check fails on that change.

interface Case {
  readonly contract: SnapshotContract;
  /** Selects a public member line that the case changes. */
  readonly member: (line: string) => boolean;
  /** Narrows the selected line, as a changed parameter type or default would. */
  readonly narrow: (line: string) => string;
}

const cases: readonly Case[] = [
  {
    contract: javaContract,
    member: (line) =>
      line.startsWith("run.workhorse.Queue: public ") && line.includes("(java.lang.String"),
    narrow: (line) => line.replace("(java.lang.String", "(java.lang.CharSequence"),
  },
  {
    contract: kotlinContract,
    member: (line) => line.includes(" fun ") && /: Int = \d+/.test(line),
    narrow: (line) => line.replace(/: Int = (\d+)/, ": Int = 1$1"),
  },
];

function committed(contract: SnapshotContract): string {
  return readFileSync(path.join(repositoryRoot, contract.path), "utf8");
}

describe.each(cases)("$contract.path", ({ contract, member, narrow }) => {
  const current = committed(contract);
  const line = current.split("\n").find(member);

  it("has a public member line to change", () => {
    expect(line).toBeDefined();
  });

  it("passes when the fresh reading matches the committed file", () => {
    expect(snapshotDrift(contract, current, current)).toBeUndefined();
  });

  it("fails and reports the line as gone when a public declaration is removed", () => {
    const fresh = current.replace(`${line}\n`, "");

    const drift = snapshotDrift(contract, current, fresh);

    expect(drift).toContain(`${contract.path} no longer describes this surface`);
    expect(drift).toContain(contract.generateCommand);
    expect(drift).toContain("breaking");
    expect(drift).toContain(`gone (1):\n  ${line}`);
    expect(drift).not.toContain("arrived");
  });

  it("fails and reports both lines when a public declaration changes", () => {
    const changed = narrow(line ?? "");
    expect(changed).not.toBe(line);
    const fresh = current.replace(line ?? "", changed);

    const drift = snapshotDrift(contract, current, fresh);

    expect(drift).toContain(`gone (1):\n  ${line}`);
    expect(drift).toContain(`arrived (1):\n  ${changed}`);
  });

  it("fails on an addition too, so the committed file stays current", () => {
    const fresh = `${current}${line}2\n`;

    expect(snapshotDrift(contract, current, fresh)).toContain(`arrived (1):\n  ${line}2`);
  });
});
