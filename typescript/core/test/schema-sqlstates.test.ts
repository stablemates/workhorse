import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../../..");

const registry = {
  P1001: ["enqueue idempotency conflict with a retained request", "v_error_message"],
  P1002: ["redrive request conflict with a retained request"],
  P1003: ["dependency cycle rejected"],
  P1004: ["child creation lost the parent lease"],
  P1005: [
    "a job accepts at most 100 prerequisite dependencies",
    "a job accepts at most 100 dependent jobs",
    "a job accepts at most 100 unresolved transitive dependent jobs",
  ],
} as const;

describe("Workhorse SQLSTATE registry", () => {
  it("assigns each declared SQLSTATE to exactly one registered failure meaning", async () => {
    const schema = await readFile(path.join(repository, "sql", "schema.sql"), "utf8");
    const declarations = [
      ...schema.matchAll(/ERRCODE\s*=\s*'(P\d{4})'\s*,\s*MESSAGE\s*=\s*(?:'([^']+)'|([a-z_]+))/g),
    ];
    const rawDeclarations = [...schema.matchAll(/ERRCODE\s*=\s*'P\d{4}'/g)];
    expect(declarations).toHaveLength(rawDeclarations.length);

    const actual = new Map<string, Set<string>>();
    for (const declaration of declarations) {
      const code = declaration[1]!;
      const meaning = declaration[2] ?? declaration[3]!;
      const meanings = actual.get(code) ?? new Set<string>();
      meanings.add(meaning);
      actual.set(code, meanings);
    }

    expect(
      Object.fromEntries([...actual].map(([code, meanings]) => [code, [...meanings]])),
    ).toEqual(registry);
  });
});
