import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildCiMatrices, WEEKLY_COMPATIBILITY_SCHEDULE } from "./ci-matrix.js";

type Support = Parameters<typeof buildCiMatrices>[0];
const { support } = JSON.parse(
  await readFile(new URL("../support.json", import.meta.url), "utf8"),
) as { support: Support & { postgres: { tested: number[] } } };
const testedJava = support.java.tested;
const testedPostgres = support.postgres.tested;

describe("the JVM lane", () => {
  // ADR 0103 "Floors": CI tests every Java release that support.json lists.
  it("tests every Java release weekly, against every PostgreSQL", () => {
    const weekly = buildCiMatrices(support, "schedule", WEEKLY_COMPATIBILITY_SCHEDULE);

    expect(weekly.jvm.include).toEqual(
      testedJava.flatMap((java) => testedPostgres.map((postgres) => ({ java, postgres }))),
    );
  });

  it("tests the floor and the newest Java release on each change", () => {
    const postgres = testedPostgres.at(-1);
    for (const event of ["pull_request", "push", "workflow_dispatch"]) {
      expect(buildCiMatrices(support, event).jvm.include).toEqual([
        { java: testedJava[0], postgres },
        { java: testedJava.at(-1), postgres },
      ]);
    }
  });

  it("refuses an empty Java list", () => {
    expect(() => buildCiMatrices({ ...support, java: { tested: [] } }, "pull_request")).toThrow(
      "CI support lists cannot be empty",
    );
  });
});
