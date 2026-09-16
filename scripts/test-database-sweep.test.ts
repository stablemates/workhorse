import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSweepTarget,
  checkoutDatabaseNames,
  classifyTestDatabase,
  planTestDatabaseSweep,
  registryDatabaseNames,
  type SweepContext,
  testFamilyRoots,
} from "./test-database-sweep.js";

const currentTemplate = "workhorse_test_template_0123456789abcdef_20260916";
const registryNames = [
  "workhorse_dev_primary_pilchard_3fd2e3ee",
  "workhorse_dev_secondary_pilchard_3fd2e3ee",
  "workhorse_test_pilchard_3fd2e3ee",
  "workhorse_bench_pilchard_3fd2e3ee",
  "workhorse_test_packed_pilchard_3fd2e3ee",
];
const protectedNames = new Set([...registryNames, ...checkoutDatabaseNames({})]);
const context: SweepContext = {
  protectedNames,
  familyRoots: testFamilyRoots(protectedNames),
  currentTemplate,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("test database classification", () => {
  it("retires the scratch database every harness names", () => {
    for (const name of [
      "workhorse_test_0fd8b8ba4c",
      "workhorse_test_hearturchin_31d32fa0_0fd8b8ba4c",
      "workhorse_test_hearturchin_31d32fa0_py_3db5c31880",
      "workhorse_test_source_1bcf29d8_go_196d5c60db",
      "workhorse_test_source_1bcf29d8_go_dashboard_196d5c60db",
    ]) {
      expect(classifyTestDatabase(name, context)).toEqual({ kind: "scratch", retired: true });
    }
  });

  it("keeps only the template the current schema hashes to", () => {
    expect(classifyTestDatabase(currentTemplate, context)).toEqual({
      kind: "template",
      retired: false,
    });
    expect(
      classifyTestDatabase("workhorse_test_template_0123456789abcdef_20260901", context),
    ).toEqual({ kind: "template", retired: true });
    expect(
      classifyTestDatabase("workhorse_test_template_fedcba9876543210_20260916", context),
    ).toEqual({ kind: "template", retired: true });
    expect(classifyTestDatabase(`${currentTemplate}_building`, context)).toEqual({
      kind: "template",
      retired: true,
    });
  });

  it("never retires a database a checkout or a worktree registry owns", () => {
    for (const name of protectedNames) {
      expect(classifyTestDatabase(name, context)).toEqual({ kind: "registry", retired: false });
    }
  });

  it("leaves a foreign database alone", () => {
    for (const name of [
      // Another project's test database on the same server: outside every known test family.
      "someapp_test_0fd8b8ba4c",
      // The demo databases, which carry no test marker at all.
      "workhorse_demo",
      "workhorse_dev",
      // A fixed scratch name, such as the pooling fixture's, carries no per-process digest.
      "workhorse_test_pilchard_3fd2e3ee_pooling",
      // A tail that is not exactly ten hexadecimal characters is not a digest.
      "workhorse_test_pilchard_3fd2e3ee_0fd8b8ba4",
      "workhorse_test_pilchard_3fd2e3ee_0fd8b8ba4cc",
      "workhorse_test_pilchard_3fd2e3ee_0fd8b8ba4g",
    ]) {
      expect(classifyTestDatabase(name, context)).toEqual({ kind: "foreign", retired: false });
    }
  });
});

describe("test family roots", () => {
  it("reduces every owned name to the root its scratch databases share", () => {
    expect([...testFamilyRoots(registryNames)]).toEqual(["workhorse_test"]);
  });

  it("ignores a name without a test marker", () => {
    expect([...testFamilyRoots(["workhorse_dev_primary", "workhorse_bench"])]).toEqual([]);
  });

  it("keeps a custom family separate from the default one", () => {
    expect([...testFamilyRoots(["acme_test", "workhorse_test_pilchard_3fd2e3ee"])]).toEqual([
      "acme_test",
      "workhorse_test",
    ]);
  });
});

describe("sweep target guards", () => {
  it("accepts the local test database", () => {
    expect(() =>
      assertSweepTarget("postgres://workhorse@localhost:5432/workhorse_test_pilchard_3fd2e3ee"),
    ).not.toThrow();
  });

  it("refuses a database name without the test purpose marker", () => {
    expect(() =>
      assertSweepTarget("postgres://workhorse@localhost:5432/workhorse_dev_primary"),
    ).toThrow(/must end in _test/);
  });

  it("refuses a database on another host", () => {
    expect(() =>
      assertSweepTarget("postgres://workhorse@db.example.com:5432/workhorse_test"),
    ).toThrow(/remote host db.example.com/);
  });
});

describe("sweep plan", () => {
  const inventory = [
    { name: "workhorse_test_pilchard_3fd2e3ee", sizeBytes: 9_000_000, inUse: true },
    { name: "workhorse_test_pilchard_3fd2e3ee_0fd8b8ba4c", sizeBytes: 8_000_000, inUse: false },
    { name: "workhorse_test_grayling_cf8ff2de_43b1eb3f3c", sizeBytes: 7_000_000, inUse: true },
    { name: currentTemplate, sizeBytes: 6_000_000, inUse: false },
    {
      name: "workhorse_test_template_0123456789abcdef_20260901",
      sizeBytes: 5_000_000,
      inUse: false,
    },
    { name: "someapp_test_0fd8b8ba4c", sizeBytes: 4_000_000, inUse: false },
  ];

  it("drops a retired database and holds back the one a session still uses", () => {
    const plan = planTestDatabaseSweep(inventory, context);

    expect(plan.drop.map((entry) => entry.name)).toEqual([
      "workhorse_test_pilchard_3fd2e3ee_0fd8b8ba4c",
      "workhorse_test_template_0123456789abcdef_20260901",
    ]);
    expect(plan.held.map((entry) => entry.name)).toEqual([
      "workhorse_test_grayling_cf8ff2de_43b1eb3f3c",
    ]);
  });
});

describe("owned database names", () => {
  it("names the five default databases of a checkout without an environment", () => {
    expect(checkoutDatabaseNames({})).toEqual([
      "workhorse_dev_primary",
      "workhorse_dev_secondary",
      "workhorse_test",
      "workhorse_bench",
      "workhorse_test_packed",
    ]);
  });

  it("reads every database a linked worktree registry claims", async () => {
    const commonGitDirectory = await temporaryGitDirectory();
    await mkdir(join(commonGitDirectory, "worktree-resources"), { recursive: true });
    await writeFile(
      join(commonGitDirectory, "worktree-resources", "pilchard.json"),
      JSON.stringify({
        version: 1,
        worktreeId: "pilchard",
        databaseUrls: Object.fromEntries(
          registryNames.map((name, index) => [
            ["dev_primary", "dev_secondary", "test", "bench", "test_packed"][index],
            `postgres://workhorse@localhost:5432/${name}`,
          ]),
        ),
      }),
    );

    expect((await registryDatabaseNames(commonGitDirectory)).toSorted()).toEqual(
      registryNames.toSorted(),
    );
  });

  it("reports no names when no worktree was ever provisioned", async () => {
    expect(await registryDatabaseNames(await temporaryGitDirectory())).toEqual([]);
  });
});

async function temporaryGitDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "workhorse-test-database-sweep-"));
  temporaryDirectories.push(path);
  return path;
}
