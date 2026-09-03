import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { schemaCompatibilityRefusal } from "../src/schema.js";
import type { SchemaCompatibilityCode } from "../src/index.js";

const repository = path.resolve(import.meta.dirname, "../../..");

/** One case from `protocol/v1/compatibility.json`, the language-neutral refusal table. */
interface CompatibilityFixture {
  readonly id: string;
  readonly installedSchemaVersion: number | null;
  readonly clientProtocolVersion: number;
  readonly servedProtocolVersions: number[];
  readonly compatible: boolean;
  readonly refusalCode?: SchemaCompatibilityCode;
}

const CODES: readonly SchemaCompatibilityCode[] = [
  "schema-not-installed",
  "schema-too-old",
  "schema-too-new",
  "client-protocol-too-old",
  "client-protocol-too-new",
];

async function loadFixtures(): Promise<readonly CompatibilityFixture[]> {
  const source = await readFile(path.join(repository, "protocol/v1/compatibility.json"), "utf8");
  return JSON.parse(source) as CompatibilityFixture[];
}

describe("schema compatibility refusals", () => {
  // Python's compatibility_refusal and Go's CheckCompatibility run the same file. A TypeScript
  // verdict that disagrees with it disagrees with the other two SDKs about the same database.
  it("reaches the fixtures' verdict and code for every case", async () => {
    const fixtures = await loadFixtures();
    expect(fixtures.length).toBeGreaterThan(0);

    const verdicts = fixtures.map((fixture) => {
      const refusal = schemaCompatibilityRefusal(
        {
          schemaVersion: fixture.installedSchemaVersion,
          servedProtocolVersions: fixture.servedProtocolVersions,
        },
        fixture.clientProtocolVersion,
      );
      return { id: fixture.id, compatible: refusal === null, code: refusal?.code ?? null };
    });

    expect(verdicts).toEqual(
      fixtures.map((fixture) => ({
        id: fixture.id,
        compatible: fixture.compatible,
        code: fixture.refusalCode ?? null,
      })),
    );
  });

  // The three SDKs freeze one vocabulary at 1.0, so a code this runtime can never produce, or one
  // it produces that the fixtures do not name, is a parity break rather than a missing test.
  it("produces every code the shared vocabulary names, and no other", async () => {
    const fixtures = await loadFixtures();
    const produced = new Set(
      fixtures
        .map(
          (fixture) =>
            schemaCompatibilityRefusal(
              {
                schemaVersion: fixture.installedSchemaVersion,
                servedProtocolVersions: fixture.servedProtocolVersions,
              },
              fixture.clientProtocolVersion,
            )?.code,
        )
        .filter((code) => code !== undefined),
    );
    expect([...produced].toSorted()).toEqual([...CODES].toSorted());
  });

  it("explains each refusal in a sentence naming the versions that disagree", () => {
    expect(
      schemaCompatibilityRefusal({ schemaVersion: 0, servedProtocolVersions: [1] }, 1),
    ).toMatchObject({
      code: "schema-too-old",
      message: expect.stringContaining("below the minimum"),
    });
    expect(
      schemaCompatibilityRefusal({ schemaVersion: 5, servedProtocolVersions: [2] }, 1),
    ).toMatchObject({
      code: "schema-too-new",
      message: expect.stringContaining("no longer serves protocol 1"),
    });
    expect(schemaCompatibilityRefusal({ schemaVersion: null, servedProtocolVersions: [] })).toEqual(
      {
        code: "schema-not-installed",
        message: expect.stringContaining("Reinstall the schema"),
      },
    );
  });
});
