import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { compareGenerated } from "./generate-go-sqlc.js";

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
