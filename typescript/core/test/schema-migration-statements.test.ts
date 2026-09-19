import { describe, expect, it } from "vitest";
import { parseSchemaMigrationMetadata, splitSqlStatements } from "../src/schema-migrations.js";

describe("splitSqlStatements", () => {
  it("splits a body at the semicolons that end statements", () => {
    expect(
      splitSqlStatements(
        "CREATE INDEX CONCURRENTLY a ON t (x);\nCREATE INDEX CONCURRENTLY b ON t (y);\n",
      ),
    ).toEqual(["CREATE INDEX CONCURRENTLY a ON t (x)", "CREATE INDEX CONCURRENTLY b ON t (y)"]);
  });

  it("returns a trailing statement that carries no semicolon", () => {
    expect(splitSqlStatements("SELECT 1")).toEqual(["SELECT 1"]);
  });

  it("ignores empty statements and whitespace between them", () => {
    expect(splitSqlStatements(" ;\nSELECT 1;\n\n;")).toEqual(["SELECT 1"]);
  });

  it("keeps a semicolon inside a string, an identifier, or a comment", () => {
    expect(splitSqlStatements("SELECT 'a;b', \"c;d\";")).toEqual(["SELECT 'a;b', \"c;d\""]);
    expect(splitSqlStatements("SELECT 'it''s; fine';")).toEqual(["SELECT 'it''s; fine'"]);
    expect(splitSqlStatements("-- a; comment\nSELECT 1;")).toEqual(["-- a; comment\nSELECT 1"]);
    expect(splitSqlStatements("/* a; /* nested; */ still */ SELECT 1;")).toEqual([
      "/* a; /* nested; */ still */ SELECT 1",
    ]);
  });

  it("keeps an E-string's escaped quote from ending the string", () => {
    expect(splitSqlStatements("SELECT E'\\';a', 2;")).toEqual(["SELECT E'\\';a', 2"]);
  });

  it("keeps a dollar-quoted body whole", () => {
    const body =
      "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  PERFORM 1;\nEND\n$$;\nSELECT 1;";
    expect(splitSqlStatements(body)).toEqual([
      "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  PERFORM 1;\nEND\n$$",
      "SELECT 1",
    ]);
  });

  it("keeps a tagged dollar-quoted body whole and does not confuse it with a parameter", () => {
    expect(splitSqlStatements("SELECT $tag$a;b$tag$, $1;")).toEqual(["SELECT $tag$a;b$tag$, $1"]);
  });
});

describe("parseSchemaMigrationMetadata", () => {
  it("reports no execution when the declaration omits it", () => {
    expect(
      parseSchemaMigrationMetadata("0002.sql", '-- workhorse-migration: {"kind":"additive"}'),
    ).toEqual({ kind: "additive", execution: undefined, retiresProtocolVersions: undefined });
  });

  it("reads a non-transactional declaration", () => {
    expect(
      parseSchemaMigrationMetadata(
        "0002.sql",
        '-- workhorse-migration: {"kind":"additive","execution":"nontransactional"}\nSELECT 1;',
      ).execution,
    ).toBe("nontransactional");
  });

  it("rejects an execution it does not recognize", () => {
    expect(() =>
      parseSchemaMigrationMetadata(
        "0002.sql",
        '-- workhorse-migration: {"kind":"additive","execution":"concurrent"}',
      ),
    ).toThrow('must declare "execution" as "transactional" or "nontransactional"');
  });
});
