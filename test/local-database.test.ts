import { describe, expect, it } from "vitest";
import {
  assertLocalDatabasePurpose,
  databaseName,
  localDatabaseUrl,
} from "../src/local-database.js";

describe("local database roles", () => {
  it.each([
    ["dev", "ironshift_dev"],
    ["test", "ironshift_test"],
    ["bench", "ironshift_bench"],
    ["demo", "ironshift_demo"],
  ] as const)("resolves the %s role independently", (purpose, expectedName) => {
    expect(databaseName(localDatabaseUrl(purpose, {}))).toBe(expectedName);
  });

  it("uses only the environment override for the requested role", () => {
    const environment = {
      IRONSHIFT_DEV_DATABASE_URL: "postgres://localhost/custom_dev",
      IRONSHIFT_TEST_DATABASE_URL: "postgres://localhost/custom_test",
      IRONSHIFT_BENCH_DATABASE_URL: "postgres://localhost/custom_bench",
      IRONSHIFT_DEMO_DATABASE_URL: "postgres://localhost/custom_demo",
      DATABASE_URL: "postgres://localhost/ignored",
    };

    expect(databaseName(localDatabaseUrl("dev", environment))).toBe("custom_dev");
    expect(databaseName(localDatabaseUrl("test", environment))).toBe("custom_test");
    expect(databaseName(localDatabaseUrl("bench", environment))).toBe("custom_bench");
    expect(databaseName(localDatabaseUrl("demo", environment))).toBe("custom_demo");
  });

  it("rejects cross-purpose destructive targets", () => {
    expect(() => assertLocalDatabasePurpose("postgres://localhost/ironshift_dev", "bench")).toThrow(
      "must end in _bench",
    );
  });
});
