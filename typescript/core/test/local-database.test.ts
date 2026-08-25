import { describe, expect, it } from "vitest";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseUrl,
  worktreeDatabaseUrl,
} from "../src/local-database.js";

describe("local database roles", () => {
  it.each([
    ["dev_primary", "workhorse_dev_primary"],
    ["dev_secondary", "workhorse_dev_secondary"],
    ["test", "workhorse_test"],
    ["bench", "workhorse_bench"],
    ["test_packed", "workhorse_test_packed"],
  ] as const)("resolves the %s role independently", (purpose, expectedName) => {
    expect(databaseName(localDatabaseUrl(purpose, {}))).toBe(expectedName);
  });

  it("uses only the environment override for the requested role", () => {
    const environment = {
      DATABASE_URL_DEV_PRIMARY: "postgres://localhost/custom_dev_primary",
      DATABASE_URL_DEV_SECONDARY: "postgres://localhost/custom_dev_secondary",
      DATABASE_URL_TEST: "postgres://localhost/custom_test",
      DATABASE_URL_BENCH: "postgres://localhost/custom_bench",
      DATABASE_URL_TEST_PACKED: "postgres://localhost/custom_test_packed",
      DATABASE_URL: "postgres://localhost/ignored",
    };

    expect(databaseName(localDatabaseUrl("dev_primary", environment))).toBe("custom_dev_primary");
    expect(databaseName(localDatabaseUrl("dev_secondary", environment))).toBe(
      "custom_dev_secondary",
    );
    expect(databaseName(localDatabaseUrl("test", environment))).toBe("custom_test");
    expect(databaseName(localDatabaseUrl("bench", environment))).toBe("custom_bench");
    expect(databaseName(localDatabaseUrl("test_packed", environment))).toBe("custom_test_packed");
  });

  it("rejects cross-purpose destructive targets", () => {
    expect(() => assertLocalDatabasePurpose("postgres://localhost/workhorse_dev", "bench")).toThrow(
      "must end in _bench",
    );
  });

  it("accepts and creates purpose-safe worktree database names", () => {
    const url = worktreeDatabaseUrl(
      "postgres://workhorse:workhorse@localhost:5432/workhorse_dev_primary",
      "dev_primary",
      "feature/my useful branch",
    );

    expect(databaseName(url)).toMatch(
      /^workhorse_dev_primary_feature_my_useful_branch_[a-f0-9]{8}$/,
    );
    expect(() => assertLocalDatabasePurpose(url, "dev_primary")).not.toThrow();
    expect(() => assertLocalDatabasePurpose(url, "dev_secondary")).toThrow(
      "must end in _dev_secondary",
    );
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
