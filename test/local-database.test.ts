import { describe, expect, it } from "vitest";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseUrl,
  worktreeDatabaseUrl,
} from "../src/local-database.js";

describe("local database roles", () => {
  it.each([
    ["dev", "workhorse_dev"],
    ["test", "workhorse_test"],
    ["bench", "workhorse_bench"],
    ["demo", "workhorse_demo"],
  ] as const)("resolves the %s role independently", (purpose, expectedName) => {
    expect(databaseName(localDatabaseUrl(purpose, {}))).toBe(expectedName);
  });

  it("uses only the environment override for the requested role", () => {
    const environment = {
      WORKHORSE_DEV_DATABASE_URL: "postgres://localhost/custom_dev",
      WORKHORSE_TEST_DATABASE_URL: "postgres://localhost/custom_test",
      WORKHORSE_BENCH_DATABASE_URL: "postgres://localhost/custom_bench",
      WORKHORSE_DEMO_DATABASE_URL: "postgres://localhost/custom_demo",
      DATABASE_URL: "postgres://localhost/ignored",
    };

    expect(databaseName(localDatabaseUrl("dev", environment))).toBe("custom_dev");
    expect(databaseName(localDatabaseUrl("test", environment))).toBe("custom_test");
    expect(databaseName(localDatabaseUrl("bench", environment))).toBe("custom_bench");
    expect(databaseName(localDatabaseUrl("demo", environment))).toBe("custom_demo");
  });

  it("rejects cross-purpose destructive targets", () => {
    expect(() => assertLocalDatabasePurpose("postgres://localhost/workhorse_dev", "bench")).toThrow(
      "must end in _bench",
    );
  });

  it("accepts and creates purpose-safe worktree database names", () => {
    const url = worktreeDatabaseUrl(
      "postgres://workhorse:workhorse@localhost:5432/workhorse_demo",
      "demo",
      "feature/my useful branch",
    );

    expect(databaseName(url)).toMatch(/^workhorse_demo_feature_my_useful_branch_[a-f0-9]{8}$/);
    expect(() => assertLocalDatabasePurpose(url, "demo")).not.toThrow();
    expect(() => assertLocalDatabasePurpose(url, "dev")).toThrow("must end in _dev");
  });

  it("keeps long worktree database names within PostgreSQL's identifier limit", () => {
    const url = worktreeDatabaseUrl(
      "postgres://localhost/a_very_long_database_prefix_that_would_otherwise_overflow_test",
      "test",
      "a-very-long-worktree-name-that-needs-truncation",
    );

    expect(databaseName(url)).toHaveLength(63);
    expect(databaseName(url)).toMatch(/_test_a_very_long_worktree_nam_[a-f0-9]{8}$/);
  });
});
