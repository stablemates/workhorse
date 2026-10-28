import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The attestation rehearsal proves one attest-action ref with the pinned uv before the publish job
// runs. If the publish job named another ref, the rehearsal would prove an action that publish does
// not use. attest-action v0.0.7 passed CI and failed only in the rehearsal (SM-1892).

const workflow = path.resolve(import.meta.dirname, "../.github/workflows/release-python.yml");

/** Each `uses: astral-sh/attest-action@<ref> # <comment>` line, without its indentation. */
function attestUses(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^-?\s*uses:\s*astral-sh\/attest-action@/.test(line));
}

describe("the attest-action pin", () => {
  it("is one SHA with its version comment in the rehearsal and the publish job", async () => {
    const uses = attestUses(await readFile(workflow, "utf8"));
    expect(uses).toHaveLength(2);
    expect(new Set(uses).size).toBe(1);
    expect(uses[0]).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });
});
