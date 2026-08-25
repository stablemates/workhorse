import { describe, expect, it } from "vitest";
import { resolveDemoDatabaseUrl } from "./environment.js";

describe("demo environment", () => {
  it("reads the repository development primary database", () => {
    expect(
      resolveDemoDatabaseUrl({
        DATABASE_URL: "postgres://localhost/workhorse_dev",
        DATABASE_URL_DEV_PRIMARY: "postgres://localhost/workhorse_dev_primary",
      }),
    ).toBe("postgres://localhost/workhorse_dev_primary");
  });
});
