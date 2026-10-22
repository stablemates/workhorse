import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildCiMatrices, DOTNET_TESTED, WEEKLY_COMPATIBILITY_SCHEDULE } from "./ci-matrix.js";

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

describe("the .NET lane", () => {
  // ADR 0107 "Floors": CI tests .NET 10 and 11, and .NET 11 at its newest release candidate until
  // it ships.
  it("tests .NET 10 on the pinned SDK and .NET 11 on its preview runtime", () => {
    expect(DOTNET_TESTED).toEqual([
      { dotnet: 10, runtime: "sdk" },
      { dotnet: 11, runtime: "preview" },
    ]);
  });

  it("tests every .NET release weekly, against every PostgreSQL", () => {
    const weekly = buildCiMatrices(support, "schedule", WEEKLY_COMPATIBILITY_SCHEDULE);

    expect(weekly.dotnet.include.map(({ dotnet }) => dotnet)).toEqual(
      [10, 11].flatMap((dotnet) => testedPostgres.map(() => dotnet)),
    );
    expect(weekly.dotnet.include).toEqual(
      DOTNET_TESTED.flatMap((release) =>
        testedPostgres.map((postgres) => ({ ...release, postgres })),
      ),
    );
  });

  it("tests .NET 10 and 11 on each change", () => {
    const postgres = testedPostgres.at(-1);
    for (const event of ["pull_request", "push", "workflow_dispatch"]) {
      expect(buildCiMatrices(support, event).dotnet.include).toEqual([
        { dotnet: 10, runtime: "sdk", postgres },
        { dotnet: 11, runtime: "preview", postgres },
      ]);
    }
  });
});
