import { readFile } from "node:fs/promises";
import { drizzleQueryable, type DrizzleExecutor } from "@stablemates/workhorse-drizzle";
import { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

/** Sends `text` through the Drizzle queryable and returns the query Drizzle would run. */
async function compile(text: string, values: readonly unknown[] = []) {
  let captured: SQL | undefined;
  const executor = {
    execute: async (query: SQL) => {
      captured = query;
      return { rows: [] };
    },
  } as DrizzleExecutor;
  await drizzleQueryable(executor).query(text, [...values]);
  if (!captured) throw new Error("the Drizzle executor was not called");
  const compiled = captured.toQuery({
    casing: undefined as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`,
    invokeSource: "indexes",
  });
  return { ...compiled, chunks: captured.queryChunks };
}

describe("Drizzle positional parameters", () => {
  it.each([
    ["a string literal", "SELECT '$1'"],
    ["an escape string literal", String.raw`SELECT E'it\'s $1'`],
    ["a doubled quote in a literal", "SELECT 'it''s $1'"],
    ["a quoted identifier", 'SELECT 1 AS "$1"'],
    ["a line comment", "SELECT 1 -- $2"],
    ["a line comment that a carriage return ends", "SELECT 1 -- $2\r"],
    ["a literal continued after a newline", "SELECT 'a'\n  -- note\n'$1'"],
    ["a continued escape string", String.raw`SELECT E'first'` + "\n" + String.raw`'it\'s $2'`],
    ["a nested block comment", "SELECT 1 /* outer /* $1 */ still $2 */"],
    ["an anonymous dollar-quoted body", "DO $$ BEGIN RAISE NOTICE '$1'; END $$"],
    ["a tagged dollar-quoted body", "SELECT $body$ $1 $$ $2 $body$"],
    ["an identifier that contains a dollar sign", "SELECT a$1 FROM b$2"],
  ])("leaves $N inside %s as text", async (_context, text) => {
    await expect(compile(text)).resolves.toMatchObject({ sql: text, params: [] });
  });

  it("sends the schema script as one raw chunk equal to the input", async () => {
    const schema = await readFile(
      new URL("../../../sql/schema/current.sql", import.meta.url),
      "utf8",
    );
    expect(schema).toMatch(/\$1/);

    const compiled = await compile(schema);

    expect(compiled).toMatchObject({ sql: schema, params: [] });
    expect(compiled.chunks).toHaveLength(1);
  });

  it("binds genuine parameters, including repeated and out-of-order ones", async () => {
    await expect(
      compile("SELECT $2::int, '$1', $1::text, $2::int -- $3", ["first", 2]),
    ).resolves.toMatchObject({
      sql: "SELECT $1::int, '$1', $2::text, $3::int -- $3",
      params: [2, "first", 2],
    });
  });

  it("binds a parameter that directly follows a literal or comment", async () => {
    await expect(
      compile("SELECT 'a'||$1, /* c */$2, $tag$ $1 $tag$||$1", ["x", "y"]),
    ).resolves.toMatchObject({
      sql: "SELECT 'a'||$1, /* c */$2, $tag$ $1 $tag$||$3",
      params: ["x", "y", "x"],
    });
  });

  it("binds a parameter after a carriage return ends a comment", async () => {
    await expect(compile("SELECT 1 -- literal $2\r, $1::int AS bound", [7])).resolves.toMatchObject(
      { sql: "SELECT 1 -- literal $2\r, $1::int AS bound", params: [7] },
    );
    await expect(compile("SELECT 1 -- literal $2\r, $1::int AS bound")).rejects.toThrow(
      new RangeError("SQL placeholder $1 has no matching value"),
    );
  });

  it("binds a parameter after a continued escape string", async () => {
    const text =
      String.raw`SELECT E'first'` + "\n" + String.raw`'it\'s $2' AS literal, $1::int AS bound`;
    await expect(compile(text, [7])).resolves.toMatchObject({ sql: text, params: [7] });
  });

  it.each([
    ["an apostrophe", "SELECT 'a'\n-- don't concatenate\n, $1::int AS bound"],
    ["a quoted placeholder", "SELECT E'a'\n-- '$2'\n, $1::int AS bound"],
  ])("binds a parameter after a line comment that holds %s", async (_context, text) => {
    // A quote inside a line comment does not continue the literal before the comment.
    await expect(compile(text, [7])).resolves.toMatchObject({ sql: text, params: [7] });
    await expect(compile(text)).rejects.toThrow(
      new RangeError("SQL placeholder $1 has no matching value"),
    );
  });

  it("gives a literal after a block comment its own escape rules", async () => {
    // PostgreSQL joins literals only across whitespace and line comments, so here the backslash
    // does not escape the quote and $2 follows the closed literal.
    const text = String.raw`SELECT E'a' /* c */` + "\n" + String.raw`'it\'s $2'`;
    await expect(compile(text, [7])).rejects.toThrow(
      new RangeError("SQL placeholder $2 has no matching value"),
    );
  });

  it("rejects a genuine parameter without a value", async () => {
    await expect(compile("SELECT '$1', $2", ["only"])).rejects.toThrow(
      new RangeError("SQL placeholder $2 has no matching value"),
    );
  });
});
