import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildCiMatrices, WEEKLY_COMPATIBILITY_SCHEDULE } from "./ci-matrix.js";

type Manifest = Parameters<typeof buildCiMatrices>[0];
type Support = Manifest["support"];
const manifest = JSON.parse(
  await readFile(new URL("../support.json", import.meta.url), "utf8"),
) as Manifest & { support: { postgres: { tested: number[] } } };
const { support, toolchains } = manifest;
const testedJava = support.java.tested;
const testedPostgres = support.postgres.tested;

describe("the JVM lane", () => {
  // ADR 0103 "Floors": CI tests every Java release that support.json lists.
  it("tests every Java release weekly, against every PostgreSQL", () => {
    const weekly = buildCiMatrices(manifest, "schedule", WEEKLY_COMPATIBILITY_SCHEDULE);

    expect(weekly.jvm.include).toEqual(
      testedJava.flatMap((java) => testedPostgres.map((postgres) => ({ java, postgres }))),
    );
  });

  it("tests the floor and the newest Java release on each change", () => {
    const postgres = testedPostgres.at(-1);
    for (const event of ["pull_request", "push", "workflow_dispatch"]) {
      expect(buildCiMatrices(manifest, event).jvm.include).toEqual([
        { java: testedJava[0], postgres },
        { java: testedJava.at(-1), postgres },
      ]);
    }
  });

  it("refuses an empty Java list", () => {
    expect(() =>
      buildCiMatrices(
        { toolchains, support: { ...support, java: { tested: [] } } },
        "pull_request",
      ),
    ).toThrow("CI support lists cannot be empty");
  });
});

/** The .NET lanes of one pull request, for a `dotnet` entry of support.json. */
function dotnetLanes(dotnet: Support["dotnet"]) {
  return buildCiMatrices({ toolchains, support: { ...support, dotnet } }, "pull_request").dotnet
    .include;
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
    const weekly = buildCiMatrices(manifest, "schedule", WEEKLY_COMPATIBILITY_SCHEDULE);

    expect(weekly.dotnet.include).toEqual(
      lanes.flatMap(({ dotnet, runtime }) =>
        testedPostgres.map((each) => ({ dotnet, runtime, postgres: each })),
      ),
    );
  });

  it("tests every .NET release on each change", () => {
    for (const event of ["pull_request", "push", "workflow_dispatch"]) {
      expect(buildCiMatrices(manifest, event).dotnet.include).toEqual(
        lanes.map(({ dotnet, runtime }) => ({ dotnet, runtime, postgres })),
      );
    }
  });

  it("refuses an empty .NET list", () => {
    expect(() => dotnetLanes({ tested: [] })).toThrow("CI support lists cannot be empty");
  });
});

describe("the Go lane", () => {
  // setup-go sets GOTOOLCHAIN=local, so each lane compiles with the release it installs. The floor
  // proves the module builds on its declared minimum, and the development compiler that mise.toml
  // pins proves the suite passes on the release that local checks use (SM-1670, QA-11).
  const floor = support.go.minimum.replace(/\.0$/, "");
  const postgres = testedPostgres.at(-1);

  it("tests the floor once on each change, as ADR 0083 requires", () => {
    for (const event of ["pull_request", "push", "workflow_dispatch"]) {
      expect(buildCiMatrices(manifest, event).go.include).toEqual([{ go: floor, postgres }]);
    }
  });

  it("tests the floor against every PostgreSQL and the development compiler weekly", () => {
    const weekly = buildCiMatrices(manifest, "schedule", WEEKLY_COMPATIBILITY_SCHEDULE);

    expect(toolchains.go).not.toBe(support.go.minimum);
    expect(weekly.go.include).toEqual([
      ...testedPostgres.map((each) => ({ go: floor, postgres: each })),
      { go: toolchains.go, postgres },
    ]);
  });

  it("records the real compiler and refuses another release before the suite runs", async () => {
    const workflow = parse(
      await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    ) as {
      jobs: Record<
        string,
        { steps: { name?: string; run?: string; env?: Record<string, string> }[] }
      >;
    };
    const steps = workflow.jobs.go?.steps ?? [];
    const record = steps.findIndex((step) => step.name === "Record the Go compiler");

    expect(steps[record]?.env).toEqual({ MATRIX_GO: "${{ matrix.go }}" });
    expect(steps[record]?.run).toContain("go version\n");
    expect(steps[record]?.run).toContain('"go$MATRIX_GO" | "go$MATRIX_GO".*) ;;');
    expect(steps[record]?.run).toContain("exit 1");
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(steps.findIndex((step) => step.run === "pnpm go:test"));
  });

  it("adds no second lane when the development compiler is the floor", () => {
    for (const go of [support.go.minimum, floor]) {
      const weekly = buildCiMatrices(
        { support, toolchains: { ...toolchains, go } },
        "schedule",
        WEEKLY_COMPATIBILITY_SCHEDULE,
      );
      expect(weekly.go.include).toEqual(
        testedPostgres.map((each) => ({ go: floor, postgres: each })),
      );
    }
  });
});
