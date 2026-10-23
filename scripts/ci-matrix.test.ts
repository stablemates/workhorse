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

/** The .NET lanes of one pull request, for a `dotnet` entry of support.json. */
function dotnetLanes(dotnet: Support["dotnet"]) {
  return buildCiMatrices({ ...support, dotnet }, "pull_request").dotnet.include;
}

describe("the .NET lane", () => {
  // ADR 0107 "Floors": CI tests every .NET release that support.json lists, and a release that has
  // not shipped at its newest release candidate.
  const postgres = testedPostgres.at(-1)!;
  const lanes = support.dotnet.tested.map((dotnet, index) => ({
    dotnet,
    runtime:
      index === 0 ? "sdk" : (support.dotnet.prerelease ?? []).includes(dotnet) ? "preview" : "ga",
  }));

  it("tests the floor on the pinned SDK and each later release on its own runtime", () => {
    expect(dotnetLanes({ tested: [10, 11], prerelease: [11] })).toEqual([
      { dotnet: 10, runtime: "sdk", postgres },
      { dotnet: 11, runtime: "preview", postgres },
    ]);
    // When .NET 11 ships, support.json removes it from `prerelease`, and its lane installs the
    // newest release runtime.
    expect(dotnetLanes({ tested: [10, 11] })).toEqual([
      { dotnet: 10, runtime: "sdk", postgres },
      { dotnet: 11, runtime: "ga", postgres },
    ]);
  });

  it("tests every .NET release weekly, against every PostgreSQL", () => {
    const weekly = buildCiMatrices(support, "schedule", WEEKLY_COMPATIBILITY_SCHEDULE);

    expect(weekly.dotnet.include).toEqual(
      lanes.flatMap(({ dotnet, runtime }) =>
        testedPostgres.map((each) => ({ dotnet, runtime, postgres: each })),
      ),
    );
  });

  it("tests every .NET release on each change", () => {
    for (const event of ["pull_request", "push", "workflow_dispatch"]) {
      expect(buildCiMatrices(support, event).dotnet.include).toEqual(
        lanes.map(({ dotnet, runtime }) => ({ dotnet, runtime, postgres })),
      );
    }
  });

  it("refuses an empty .NET list", () => {
    expect(() => dotnetLanes({ tested: [] })).toThrow("CI support lists cannot be empty");
  });
});
