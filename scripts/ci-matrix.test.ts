import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildCiMatrices,
  TESTED_JAVA_RELEASES,
  WEEKLY_COMPATIBILITY_SCHEDULE,
} from "./ci-matrix.js";

type Support = Parameters<typeof buildCiMatrices>[0];
const { support } = JSON.parse(
  await readFile(new URL("../support.json", import.meta.url), "utf8"),
) as { support: Support & { postgres: { tested: number[] } } };
const testedPostgres = support.postgres.tested;

describe("the JVM lane", () => {
  // ADR 0103 "Floors": CI tests Java 21, 25, and 27.
  it("tests every Java release weekly, against every PostgreSQL", () => {
    const weekly = buildCiMatrices(support, "schedule", WEEKLY_COMPATIBILITY_SCHEDULE);

    expect(TESTED_JAVA_RELEASES).toEqual([21, 25, 27]);
    expect([...new Set(weekly.jvm.include.map((lane) => lane.java))]).toEqual([21, 25, 27]);
    expect(weekly.jvm.include).toHaveLength(TESTED_JAVA_RELEASES.length * testedPostgres.length);
  });

  it("tests the floor and the newest Java release on each change", () => {
    const postgres = testedPostgres.at(-1);
    for (const event of ["pull_request", "push", "workflow_dispatch"]) {
      expect(buildCiMatrices(support, event).jvm.include).toEqual([
        { java: 21, postgres },
        { java: 27, postgres },
      ]);
    }
  });
});
