import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PARITY_TABLES,
  type ParityRow,
} from "../typescript/core/test/support/parity-capabilities.js";
import { jvmEvidenceProblems, readJvmEvidenceState } from "./jvm-parity-evidence.js";
import { repositoryRoot } from "./packages.js";

const state = readJvmEvidenceState(repositoryRoot);
const test = {
  file: "dev/stablemates/workhorse/QueueDatabaseTest.java",
  test: "storesEveryTaskOption",
};

function row(jvm: unknown, capability = "Probe"): ParityRow {
  const planned = { planned: "SM-1" };
  return {
    capability,
    typescript: planned,
    python: planned,
    go: planned,
    rust: planned,
    ruby: planned,
    jvm: jvm as ParityRow["jvm"],
  };
}

describe("JVM parity evidence", () => {
  it("accepts every JVM cell the registry declares", () => {
    expect(jvmEvidenceProblems(PARITY_TABLES.flat(), state)).toEqual([]);
  });

  it("reads the declared fixtures, the expected-unsupported list, and the test methods", () => {
    expect(state.declared.has("scenarios/fast-tier")).toBe(true);
    expect(state.unsupported.get("runtime/priority-ordered-mixed-batch")).toBe("SM-1388");
    expect(state.tests.get(test.file)?.has(test.test)).toBe(true);
    expect(
      state.tests
        .get("dev/stablemates/workhorse/conformance/ProtocolConformanceTest.java")
        ?.has("failsTheRunForAnUnlistedFailingFixture"),
    ).toBe(true);
  });

  it("accepts a test method that pnpm jvm:test runs", () => {
    expect(jvmEvidenceProblems([row(test)], state)).toEqual([]);
  });

  it("rejects a row without a JVM cell", () => {
    expect(jvmEvidenceProblems([row(undefined)], state)).toEqual([
      "Probe: the JVM column needs a cell",
    ]);
  });

  it("rejects a file that pnpm jvm:test does not run", () => {
    expect(jvmEvidenceProblems([row({ ...test, file: "QueueDatabaseTest.java" })], state)).toEqual([
      "Probe: pnpm jvm:test does not run QueueDatabaseTest.java",
    ]);
  });

  it("rejects a name that is not a test method in the file", () => {
    expect(jvmEvidenceProblems([row({ file: test.file, test: "storesEvery" })], state)).toEqual([
      `Probe: ${test.file} has no test method storesEvery`,
    ]);
  });

  it("rejects a JVM Supported cell that cites a pattern instead of executed evidence", () => {
    expect(jvmEvidenceProblems([row({ file: test.file, pattern: "enqueue" })], state)).toEqual([
      "Probe: a JVM Supported cell must cite protocol/v1 fixtures or a test method",
    ]);
  });

  it("rejects a JVM Supported cell that cites no fixtures", () => {
    expect(jvmEvidenceProblems([row({ fixtures: [] })], state)).toEqual([
      "Probe: a JVM Supported cell cites no fixtures",
    ]);
  });

  it("rejects a fixture that protocol/v1 does not declare", () => {
    expect(jvmEvidenceProblems([row({ fixtures: ["scenarios/invented"] })], state)).toEqual([
      "Probe: scenarios/invented is not a protocol/v1 fixture",
    ]);
  });

  it("rejects a fixture the JVM runner lists as expected unsupported", () => {
    expect(
      jvmEvidenceProblems([row({ fixtures: ["runtime/priority-ordered-mixed-batch"] })], state),
    ).toEqual([
      "Probe: runtime/priority-ordered-mixed-batch is expected unsupported in the JVM lane (SM-1388), so the cell cannot be Supported",
    ]);
  });

  it("reads no test from a file that names @Disabled, in any order or form", () => {
    const root = mkdtempSync(path.join(tmpdir(), "jvm-parity-evidence-"));
    cpSync(path.join(repositoryRoot, "protocol/v1"), path.join(root, "protocol/v1"), {
      recursive: true,
    });
    const resources = path.join(root, "jvm/workhorse/src/test/resources/conformance");
    mkdirSync(resources, { recursive: true });
    writeFileSync(path.join(resources, "expected-unsupported.json"), '{"fixtures": []}');
    const tests = path.join(root, "jvm/workhorse/src/test/java/probe");
    mkdirSync(tests, { recursive: true });
    writeFileSync(
      path.join(tests, "ProbeTest.java"),
      [
        "class ProbeTest {",
        "  @Test",
        "  void runs() {}",
        '  @Tag("slow")',
        "  @Test",
        "  void tagged() {}",
        "  void helper() {}",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      path.join(tests, "MultilineTest.java"),
      [
        "class MultilineTest {",
        "  @Disabled(",
        '      "flaky")',
        "  @Test",
        "  void disabled() {}",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      path.join(tests, "SkippedTest.java"),
      ["@Disabled", "class SkippedTest {", "  @Test", "  void runs() {}", "}"].join("\n"),
    );
    const probe = readJvmEvidenceState(root);
    expect([...(probe.tests.get("probe/ProbeTest.java") ?? [])]).toEqual(["runs", "tagged"]);
    expect([...(probe.tests.get("probe/MultilineTest.java") ?? [])]).toEqual([]);
    expect([...(probe.tests.get("probe/SkippedTest.java") ?? [])]).toEqual([]);
  });

  it("leaves a Planned JVM cell alone", () => {
    expect(jvmEvidenceProblems([row({ planned: "SM-1387" })], state)).toEqual([]);
  });
});
