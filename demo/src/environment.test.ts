import { describe, expect, it } from "vitest";
import { resolveDemoDatabaseUrl } from "./environment.js";

describe("demo environment", () => {
  it("prefers the demo-specific database over a generic application database", () => {
    expect(
      resolveDemoDatabaseUrl({
        DATABASE_URL: "postgres://localhost/workhorse_dev",
        WORKHORSE_DEMO_DATABASE_URL: "postgres://localhost/workhorse_demo",
      }),
    ).toBe("postgres://localhost/workhorse_demo");
  });

  it("accepts DATABASE_URL when no demo-specific override is defined", () => {
    expect(resolveDemoDatabaseUrl({ DATABASE_URL: "postgres://localhost/custom" })).toBe(
      "postgres://localhost/custom",
    );
  });
});
