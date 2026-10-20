import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { landingSnippetLanguages, landingSnippets } from "../site/lib/landing-snippets.js";
import type { LandingSnippetId } from "../site/lib/landing-snippets.js";
import { createDatabaseTestHarness } from "../typescript/core/test/support/db.js";

// A retry policy with a wrong key compiles and type-checks, and PostgreSQL refuses it at enqueue.
// This test reads the policy literal of every landing snippet and gives it to
// `workhorse.normalize_retry_policy_v1`, the function that the enqueue path calls. The tests that
// run each snippet against PostgreSQL also catch it; this test names the key in all seven
// languages at once.

const languages = ["ts", "python", "go", "rust", "ruby", "java", "kotlin"] as const;

// The option name in each SDK: `retryPolicy`, `retry_policy`, or `RetryPolicy`.
const policyOption = /\b(?:retryPolicy|retry_policy|RetryPolicy)\b/g;

// A string literal, a bare key before a colon (TypeScript and Ruby symbols), or a number. Other
// tokens such as `json!`, `Map.of`, `mapOf`, `to`, `=>`, and `map[string]any` carry no data.
const policyToken = /"((?:[^"\\]|\\.)*)"|\b([A-Za-z_]\w*)\s*:(?!:)|(-?\d[\d_]*(?:\.\d[\d_]*)?)/g;

const harness = createDatabaseTestHarness(import.meta.url);

beforeAll(harness.setup);
afterAll(harness.teardown);

describe("landing snippet retry policies", () => {
  const policies = Object.entries(landingSnippets).flatMap(([id, source]) =>
    retryPolicies(source).map((policy) => ({
      id,
      language: landingSnippetLanguages[id as LandingSnippetId] ?? "ts",
      policy,
    })),
  );

  it("finds a retry policy in the landing snippets of each language", () => {
    expect(new Set(policies.map(({ language }) => language))).toEqual(new Set(languages));
  });

  it.each(policies)("$id sends a policy that PostgreSQL accepts", async ({ policy }) => {
    const result = await harness.pool.query<{ normalized: unknown }>(
      "SELECT workhorse.normalize_retry_policy_v1($1::jsonb) AS normalized",
      [JSON.stringify(policy)],
    );
    expect(result.rows[0]?.normalized).toEqual(policy);
  });
});

function retryPolicies(source: string): Record<string, unknown>[] {
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|#)/.test(line))
    .join("\n");
  return [...code.matchAll(policyOption)].map((match) =>
    policyObject(literalAfter(code, match.index + match[0].length)),
  );
}

// The text between the first `{` or `(` after `start` and its matching close.
function literalAfter(code: string, start: number): string {
  const open = code.slice(start).search(/[{(]/);
  if (open < 0) throw new Error(`no retry policy literal after offset ${start}`);
  let depth = 0;
  for (let index = start + open; index < code.length; index++) {
    const character = code[index];
    if (character === '"') {
      index = code.indexOf('"', index + 1);
      while (code[index - 1] === "\\") index = code.indexOf('"', index + 1);
    } else if (character === "{" || character === "(") {
      depth++;
    } else if ((character === "}" || character === ")") && --depth === 0) {
      return code.slice(start + open + 1, index);
    }
  }
  throw new Error(`unclosed retry policy literal after offset ${start}`);
}

function policyObject(literal: string): Record<string, unknown> {
  const tokens = [...literal.matchAll(policyToken)].map(([, text, key, number]) =>
    number === undefined ? (text ?? key) : Number(number.replaceAll("_", "")),
  );
  if (tokens.length % 2 !== 0) {
    throw new Error(`retry policy literal has no value for one key: ${literal}`);
  }
  const policy: Record<string, unknown> = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    if (typeof key !== "string") throw new Error(`retry policy key is not a string: ${literal}`);
    policy[key] = tokens[index + 1];
  }
  return policy;
}
