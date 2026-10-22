import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { jdbcStatement } from "./sql-catalogue-jdbc.js";

/**
 * Each `?` in the JVM catalogue that has no cast, by statement name and 1-based JDBC index. The JVM
 * `Sql` runner binds text as an untyped parameter. PostgreSQL types each of these from its context
 * alone. Add an entry only after a JDBC test runs the statement with real values.
 */
const uncastPlaceholders: Record<string, Record<number, string>> = {
  sync_rate_limit_policies_v1__queue: {
    // sync_rate_limit_policies_v1 has one signature, so PostgreSQL types the values as its text
    // p_namespace and its boolean p_prune.
    1: "p_namespace text argument",
    3: "p_prune boolean argument",
  },
};

describe("the JDBC form of a catalogue statement", () => {
  it("rewrites each $n to ? and records the parameter that each ? binds", () => {
    expect(jdbcStatement("SELECT workhorse.claim_v1($1, $2::jsonb[], $10)")).toEqual({
      sql: "SELECT workhorse.claim_v1(?, ?::jsonb[], ?)",
      parameters: [1, 2, 10],
      uncast: [1, 3],
    });
  });

  it("binds a repeated parameter at each use", () => {
    expect(jdbcStatement("WHERE a = $1 OR b = $1 AND c = $2")).toEqual({
      sql: "WHERE a = ? OR b = ? AND c = ?",
      parameters: [1, 1, 2],
      uncast: [1, 2, 3],
    });
  });

  it("escapes a ? operator, which PgJDBC would read as a parameter", () => {
    expect(jdbcStatement("SELECT payload ? 'key' AND payload ?| $1")).toEqual({
      sql: "SELECT payload ?? 'key' AND payload ??| ?",
      parameters: [1],
      uncast: [1],
    });
  });

  it("leaves literals, quoted identifiers, comments, and dollar quotes as they are", () => {
    const sql = [
      "SELECT '$1 ?', 'it''s $2', \"col$3?\"",
      "-- $4 ?",
      "/* $5 ? */ $f$ $6 ? $f$, $$ $7 $$, $1",
    ].join("\n");
    expect(jdbcStatement(sql)).toEqual({
      sql: sql.replace(/\$1$/, "?"),
      parameters: [1],
      uncast: [1],
    });
  });

  it("reads backslash escapes only in an escape string", () => {
    expect(jdbcStatement("SELECT E'it\\'s $1 ?', $1::text")).toEqual({
      sql: "SELECT E'it\\'s $1 ?', ?::text",
      parameters: [1],
      uncast: [],
    });
    expect(jdbcStatement("SELECT 'a\\', $1, name'x'")).toEqual({
      sql: "SELECT 'a\\', ?, name'x'",
      parameters: [1],
      uncast: [1],
    });
  });

  it("keeps a $ inside an unquoted identifier", () => {
    expect(jdbcStatement("SELECT name$1, a$b$ FROM t WHERE x = $1")).toEqual({
      sql: "SELECT name$1, a$b$ FROM t WHERE x = ?",
      parameters: [1],
      uncast: [1],
    });
    expect(jdbcStatement("SELECT é$1, éE'x' FROM t WHERE id = $1")).toEqual({
      sql: "SELECT é$1, éE'x' FROM t WHERE id = ?",
      parameters: [1],
      uncast: [1],
    });
  });

  it("ends a line comment at either line end", () => {
    expect(jdbcStatement("SELECT 1 -- note\r, $1 -- $2\n, $3")).toEqual({
      sql: "SELECT 1 -- note\r, ? -- $2\n, ?",
      parameters: [1, 3],
      uncast: [1, 2],
    });
  });

  it("skips a nested block comment as one comment", () => {
    expect(jdbcStatement("SELECT /* a /* $1 */ ? */ $2")).toEqual({
      sql: "SELECT /* a /* $1 */ ? */ ?",
      parameters: [2],
      uncast: [1],
    });
  });

  it("refuses an unterminated literal, comment, or dollar quote", () => {
    expect(() => jdbcStatement("SELECT 'open")).toThrow("unterminated string literal");
    expect(() => jdbcStatement('SELECT "open')).toThrow("unterminated quoted identifier");
    expect(() => jdbcStatement("SELECT /* /* */")).toThrow("unterminated block comment");
    expect(() => jdbcStatement("SELECT $tag$ open")).toThrow("unterminated dollar quote");
  });

  it("lists each ? that no cast follows", () => {
    expect(jdbcStatement("WHERE $1::integer = $2 :: integer").uncast).toEqual([]);
    // The detector is conservative. A person reviews these forms in the list below.
    expect(jdbcStatement("WHERE CAST($1 AS integer) = $2 /* note */ ::integer").uncast).toEqual([
      1, 2,
    ]);
    expect(jdbcStatement("WHERE $1::integer IS NOT NULL AND make_interval(days => $1)")).toEqual({
      sql: "WHERE ?::integer IS NOT NULL AND make_interval(days => ?)",
      parameters: [1, 1],
      uncast: [2],
    });
  });
});

describe("the uncast placeholders of the JVM catalogue", () => {
  it("are exactly the reviewed list", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(import.meta.dirname, "../protocol/v1/manifest.json"), "utf8"),
    ) as { statements: { name: string; contract: string }[] };
    const found: Record<string, number[]> = {};
    for (const statement of manifest.statements) {
      const { uncast } = jdbcStatement(statement.contract);
      if (uncast.length > 0) found[statement.name] = uncast;
    }
    const reviewed = Object.fromEntries(
      Object.entries(uncastPlaceholders).map(([name, indexes]) => [
        name,
        Object.keys(indexes).map(Number),
      ]),
    );
    expect(found).toEqual(reviewed);
  });
});
