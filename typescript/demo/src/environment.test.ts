import { describe, expect, it } from "vitest";
import {
  demoDatabaseHostLabel,
  demoDatabaseNameLabel,
  resolveDemoDatabaseUrl,
} from "./environment.js";

describe("demo environment", () => {
  it("reads the repository development primary database", () => {
    expect(
      resolveDemoDatabaseUrl({
        DATABASE_URL: "postgres://localhost/workhorse_dev",
        DATABASE_URL_PRIMARY: "postgres://localhost/workhorse_dev_primary",
      }),
    ).toBe("postgres://localhost/workhorse_dev_primary");
  });

  it("labels a database URL by its network host", () => {
    expect(demoDatabaseHostLabel("postgres://user:pw@db.internal:5433/demo")).toBe(
      "db.internal:5433",
    );
    expect(demoDatabaseHostLabel("postgres://localhost/demo")).toBe("localhost");
  });

  it("labels a socket-connected URL by its socket directory", () => {
    expect(demoDatabaseHostLabel("postgres:///demo?host=/var/run/postgresql")).toBe(
      "/var/run/postgresql",
    );
  });

  it("labels a database URL by its database name", () => {
    expect(demoDatabaseNameLabel("postgres://user:pw@db.internal:5433/demo")).toBe("demo");
    expect(demoDatabaseNameLabel("postgres:///workhorse_demo?host=/var/run/postgresql")).toBe(
      "workhorse_demo",
    );
    expect(demoDatabaseNameLabel("postgres://localhost")).toBeUndefined();
  });

  it("labels nothing when the URL does not parse", () => {
    expect(demoDatabaseHostLabel("not a url")).toBeUndefined();
    expect(demoDatabaseNameLabel("not a url")).toBeUndefined();
  });
});
