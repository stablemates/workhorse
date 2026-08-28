import { describe, expect, it } from "vitest";
import {
  demoDatabaseHostLabel,
  demoDatabaseNameLabel,
  resolveDemoDatabaseUrl,
  resolveDemoSchemaTargets,
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

  it("prepares both configured workspace databases", () => {
    expect(
      resolveDemoSchemaTargets({
        DATABASE_URL_PRIMARY: "postgres://primary/demo",
        DATABASE_URL_SECONDARY: "postgres://secondary/demo",
      }),
    ).toEqual([
      { name: "production", url: "postgres://primary/demo" },
      { name: "staging", url: "postgres://secondary/demo" },
    ]);
  });

  it("prepares only production in single-workspace mode", () => {
    expect(resolveDemoSchemaTargets({ DATABASE_URL_PRIMARY: "postgres://primary/demo" })).toEqual([
      { name: "production", url: "postgres://primary/demo" },
    ]);
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

  it("labels a credentialed socket-connected URL", () => {
    const url = "postgresql://workhorse:secret@/workhorse_demo?host=/var/run/postgresql";

    expect(demoDatabaseHostLabel(url)).toBe("/var/run/postgresql");
    expect(demoDatabaseNameLabel(url)).toBe("workhorse_demo");
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
