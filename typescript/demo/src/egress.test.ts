import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The public demo executes anonymous, operator-admitted jobs inside a container that also holds
 * the demo databases' credentials. The claim that demo work can reach neither those credentials
 * nor an external service rests on one property: every handler is fixed code compiled into the
 * image, and nothing in the job path imports a network or process primitive, reads the
 * environment, or evaluates payload text as code. These assertions keep that property true.
 */
const TYPESCRIPT_JOB_SOURCES = [
  "handlers.ts",
  "durable-demo.ts",
  "feature-showcase.ts",
  "contracts.ts",
  "schema.ts",
] as const;

const FORBIDDEN_NETWORK_OR_PROCESS = [
  /from\s+["']node:(?:http|https|net|tls|dgram|dns|child_process|worker_threads|cluster)["']/,
  /(?<![\w$])fetch\s*\(/,
  /new\s+(?:WebSocket|EventSource)\s*\(/,
  /(?<![\w$])eval\s*\(/,
  /new\s+Function\s*\(/,
  /\bimport\s*\(/,
];

const FORBIDDEN_ENVIRONMENT = [/process\.env\b/];

const PYTHON_FORBIDDEN = [
  /urllib/,
  /(?<![\w.])requests\b/,
  /httpx/,
  /http\.client/,
  /smtplib/,
  /subprocess/,
  /os\.system/,
  /socket\.(?:create_connection|socket|fromfd)/,
  /(?<![\w.])eval\s*\(/,
  /(?<![\w.])exec\s*\(/,
];

const GO_FORBIDDEN = [/"net\/(?:http|smtp)"/, /"os\/exec"/, /"plugin"/, /net\.Dial/, /net\.Listen/];

function violations(source: string, patterns: readonly RegExp[]): string[] {
  return patterns.filter((pattern) => pattern.test(source)).map(String);
}

describe("demo job isolation", () => {
  it("keeps TypeScript job code free of network, process, and credential access", async () => {
    for (const file of TYPESCRIPT_JOB_SOURCES) {
      const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
      expect(
        violations(source, [...FORBIDDEN_NETWORK_OR_PROCESS, ...FORBIDDEN_ENVIRONMENT]),
        `${file} must not reach the network, the process table, or the environment`,
      ).toEqual([]);
    }
  });

  it("keeps the worker entry points free of network and process primitives", async () => {
    for (const file of ["worker.ts", "worker-main.ts", "worker-definition.ts", "staging.ts"]) {
      const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
      expect(
        violations(source, FORBIDDEN_NETWORK_OR_PROCESS),
        `${file} must not reach the network or the process table`,
      ).toEqual([]);
    }
  });

  it("keeps the Python and Go demo workers free of egress", async () => {
    const python = await readFile(
      new URL("../../../python/examples/demo_worker.py", import.meta.url),
      "utf8",
    );
    expect(violations(python, PYTHON_FORBIDDEN)).toEqual([]);

    const go = await readFile(
      new URL("../../../go/examples/demo-worker/main.go", import.meta.url),
      "utf8",
    );
    expect(violations(go, GO_FORBIDDEN)).toEqual([]);
  });
});
