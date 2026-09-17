import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const decisionsDirectory = path.join(root, "docs/decisions");

/**
 * Decision records by the number their file name carries.
 *
 * Two pull requests open at the same time each take the next free number, and the second one to
 * merge carries a number the first already used. Nothing noticed the first collision for five days,
 * and the second was found while cutting a release. A number a reader cannot resolve to one
 * decision is the cost, so the number is an identifier and this treats it as one.
 */
function recordsByNumber(fileNames: readonly string[]): Map<string, string[]> {
  const byNumber = new Map<string, string[]>();
  for (const fileName of fileNames) {
    const number = /^(\d{4})-/.exec(fileName)?.[1];
    if (!number) continue;
    byNumber.set(number, [...(byNumber.get(number) ?? []), fileName]);
  }
  return byNumber;
}

function duplicates(fileNames: readonly string[]): string[] {
  return [...recordsByNumber(fileNames)]
    .filter(([, files]) => files.length > 1)
    .map(([number, files]) => `${number}: ${files.toSorted().join(", ")}`)
    .toSorted();
}

async function decisionFileNames(): Promise<string[]> {
  return (await readdir(decisionsDirectory)).filter((name) => name.endsWith(".md"));
}

describe("the decision records", () => {
  it("give each number to one record", async () => {
    expect(duplicates(await decisionFileNames())).toEqual([]);
  });

  it("name the same number in the file name and the heading", async () => {
    const mismatched: string[] = [];
    for (const fileName of await decisionFileNames()) {
      const number = /^(\d{4})-/.exec(fileName)?.[1];
      if (!number) continue;
      const heading = (await readFile(path.join(decisionsDirectory, fileName), "utf8")).split(
        "\n",
      )[0];
      if (!heading?.startsWith(`# ADR ${number}:`)) {
        mismatched.push(`${fileName}: ${heading ?? "(empty)"}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  // The case above passes whenever the directory is clean, including when this stops reading it at
  // all. This one fails on a directory that is not.
  it("report a reused number with both records", () => {
    expect(
      duplicates([
        "0065-publish-the-verified-sqlalchemy-transaction-accessor.md",
        "0065-publish-validated-deployment-references.md",
        "0066-skip-missed-schedule-occurrences-by-default.md",
      ]),
    ).toEqual([
      "0065: 0065-publish-the-verified-sqlalchemy-transaction-accessor.md, 0065-publish-validated-deployment-references.md",
    ]);
  });
});
