import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSweepTarget,
  checkoutDatabaseNames,
  classifyTestDatabase,
  liveSchemaTemplates,
  planTestDatabaseSweep,
  registryDatabaseNames,
  type SweepContext,
  testFamilyRoots,
  listWorktreeRoots,
  parseWorktreeList,
  readDatabaseInventory,
} from "./test-database-sweep.js";
import { schemaTemplateName } from "../typescript/core/test/support/schema-template.js";

const currentTemplate = "workhorse_test_template_0123456789abcdef_20260916";
// A second worktree on a branch with a migration, so its schema digest is different.
const migrationTemplate = "workhorse_test_template_fedcba9876543210_20260916";
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
  liveTemplates: new Set([currentTemplate, migrationTemplate]),
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
      "workhorse_test_source_1bcf29d8_rb_196d5c60db",
    ]) {
      expect(classifyTestDatabase(name, context)).toEqual({ kind: "scratch", retired: true });
    }
  });

  it("keeps only the templates the current schema of a worktree hashes to", () => {
    for (const name of [currentTemplate, migrationTemplate]) {
      expect(classifyTestDatabase(name, context)).toEqual({ kind: "template", retired: false });
    }
    expect(
      classifyTestDatabase("workhorse_test_template_0123456789abcdef_20260901", context),
    ).toEqual({ kind: "template", retired: true });
    expect(
      classifyTestDatabase("workhorse_test_template_0011223344556677_20260916", context),
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

describe("database inventory", () => {
  it("leaves out a database that another checkout drops during the read", async () => {
    // 42704 is the code of PostgreSQL 18, and 3D000 the code of older versions.
    const droppedCodes: Record<string, string> = { "200": "42704", "400": "3D000" };
    const admin = {
      async query(text: string, values?: unknown[]) {
        if (text.includes("FROM pg_database")) {
          return {
            rows: [100, 200, 300, 400, 500].map((oid) => ({
              oid: String(oid),
              name: inventoryName(oid),
              in_use: oid === 500,
            })),
          };
        }
        const oid = String(values?.[0]);
        const code = droppedCodes[oid];
        if (code !== undefined) {
          throw Object.assign(new Error(`database with OID ${oid} does not exist`), { code });
        }
        return { rows: [{ size_bytes: oid === "300" ? null : `${Number(oid) * 10}` }] };
      },
    };

    expect(await readDatabaseInventory(admin as never)).toEqual([
      { name: inventoryName(100), sizeBytes: 1000, inUse: false },
      { name: inventoryName(500), sizeBytes: 5000, inUse: true },
    ]);
  });

  it("reports any other error of the size read", async () => {
    const admin = {
      async query(text: string) {
        if (text.includes("FROM pg_database")) {
          return { rows: [{ oid: "100", name: "workhorse_test", in_use: false }] };
        }
        throw Object.assign(new Error("permission denied"), { code: "42501" });
      },
    };

    await expect(readDatabaseInventory(admin as never)).rejects.toThrow(/permission denied/);
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

describe("live schema templates", () => {
  const now = new Date("2026-09-16T12:00:00Z");

  it("names the template of each worktree's current schema, also when the digests differ", async () => {
    const main = await worktreeWithSchema("CREATE SCHEMA workhorse;\n");
    const migration = await worktreeWithSchema("CREATE SCHEMA workhorse;\n-- a migration\n");
    const live = await liveSchemaTemplates([main, migration], now);

    const expected = [
      schemaTemplateName(Buffer.from("CREATE SCHEMA workhorse;\n"), now),
      schemaTemplateName(Buffer.from("CREATE SCHEMA workhorse;\n-- a migration\n"), now),
    ];
    expect(new Set(expected).size).toBe(2);
    expect([...live].toSorted()).toEqual(expected.toSorted());
    for (const name of expected) {
      expect(classifyTestDatabase(name, { ...context, liveTemplates: live })).toEqual({
        kind: "template",
        retired: false,
      });
    }
  });

  it("skips a worktree without a current schema", async () => {
    expect(await liveSchemaTemplates([await temporaryGitDirectory()], now)).toEqual(new Set());
  });

  it("keeps a worktree path that contains a newline whole", () => {
    const listing = [
      "worktree /work/main",
      "HEAD 0123456789abcdef0123456789abcdef01234567",
      "branch refs/heads/main",
      "",
      "worktree /work/odd\nname",
      "HEAD fedcba9876543210fedcba9876543210fedcba98",
      "detached",
      "",
      "",
    ].join("\0");

    expect(parseWorktreeList(listing)).toEqual(["/work/main", "/work/odd\nname"]);
  });

  it("finds this checkout among the worktrees git lists", () => {
    expect(listWorktreeRoots(process.cwd())).toContain(process.cwd());
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

function inventoryName(oid: number): string {
  return `workhorse_test_pilchard_3fd2e3ee_${oid}d8b8ba4c`;
}

async function worktreeWithSchema(schema: string): Promise<string> {
  const root = await temporaryGitDirectory();
  await mkdir(join(root, "sql", "schema"), { recursive: true });
  await writeFile(join(root, "sql", "schema", "current.sql"), schema);
  return root;
}

async function temporaryGitDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "workhorse-test-database-sweep-"));
  temporaryDirectories.push(path);
  return path;
}
