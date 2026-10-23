import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PARITY_TABLES,
  type ParityRow,
} from "../typescript/core/test/support/parity-capabilities.js";
import { dotnetEvidenceProblems, readDotnetEvidenceState } from "./dotnet-parity-evidence.js";
import { repositoryRoot } from "./packages.js";

const state = readDotnetEvidenceState(repositoryRoot);
const test = {
  file: "Workhorse.Tests/Client/QueueEnqueueTests.cs",
  test: "EnqueuesAnAtomicBatchInRequestOrder",
};

function row(dotnet: unknown, capability = "Probe"): ParityRow {
  const planned = { planned: "SM-1" };
  return {
    capability,
    typescript: planned,
    python: planned,
    go: planned,
    rust: planned,
    ruby: planned,
    jvm: planned,
    dotnet: dotnet as ParityRow["dotnet"],
  };
}

describe(".NET parity evidence", () => {
  it("accepts every .NET cell the registry declares", () => {
    expect(dotnetEvidenceProblems(PARITY_TABLES.flat(), state)).toEqual([]);
  });

  it("gives every capability a Supported .NET cell, as Gate 6 requires", () => {
    expect(
      PARITY_TABLES.flat()
        .filter((entry) => entry.dotnet === undefined || "planned" in entry.dotnet)
        .map((entry) => entry.capability),
    ).toEqual([]);
  });

  it("reads the declared fixtures, the expected-unsupported list, and the test methods of both projects", () => {
    expect(state.declared.has("runtime/priority-ordered-mixed-batch")).toBe(true);
    expect(state.unsupported).toEqual(new Map());
    expect(state.tests.get(test.file)?.has(test.test)).toBe(true);
    expect(
      state.tests
        .get("Workhorse.Tests/Conformance/ProtocolConformanceTests.cs")
        ?.has("ExecutesEveryProtocolFixtureAndAgreesWithTheExpectedUnsupportedList"),
    ).toBe(true);
    expect(
      state.tests
        .get("Workhorse.AspNetCore.Tests/DashboardConformanceTests.cs")
        ?.has("AnswersEverySharedExchangeAndReportsThePoliciesBehindAQueue"),
    ).toBe(true);
  });

  it("accepts a test method that pnpm dotnet:test runs", () => {
    expect(dotnetEvidenceProblems([row(test)], state)).toEqual([]);
  });

  it("rejects a row without a .NET cell", () => {
    expect(dotnetEvidenceProblems([row(undefined)], state)).toEqual([
      "Probe: the .NET column needs a cell",
    ]);
  });

  it("rejects a file that pnpm dotnet:test does not run", () => {
    expect(dotnetEvidenceProblems([row({ ...test, file: "QueueEnqueueTests.cs" })], state)).toEqual(
      ["Probe: pnpm dotnet:test does not run QueueEnqueueTests.cs"],
    );
  });

  it("rejects a name that is not a test method in the file", () => {
    expect(dotnetEvidenceProblems([row({ file: test.file, test: "Enqueues" })], state)).toEqual([
      `Probe: ${test.file} has no test method Enqueues`,
    ]);
  });

  it("checks the implementation that a cell names beside its test", () => {
    const implementation = { file: "dotnet/src/Workhorse/Queue.cs", pattern: "EnqueueManyAsync" };
    expect(dotnetEvidenceProblems([row({ ...test, implementation })], state)).toEqual([]);
    expect(
      dotnetEvidenceProblems(
        [row({ ...test, implementation: { ...implementation, pattern: "NoSuchMethod" } })],
        state,
      ),
    ).toEqual(["Probe: dotnet/src/Workhorse/Queue.cs never mentions NoSuchMethod"]);
    expect(
      dotnetEvidenceProblems(
        [row({ ...test, implementation: { ...implementation, file: "dotnet/src/Gone.cs" } })],
        state,
      ),
    ).toEqual(["Probe: the implementation dotnet/src/Gone.cs does not exist"]);
  });

  it("checks each test of a cell that cites several", () => {
    expect(dotnetEvidenceProblems([row({ tests: [test, test] })], state)).toEqual([]);
    expect(
      dotnetEvidenceProblems([row({ tests: [test, { ...test, test: "Gone" }] })], state),
    ).toEqual([`Probe: ${test.file} has no test method Gone`]);
    expect(dotnetEvidenceProblems([row({ tests: [] })], state)).toEqual([
      "Probe: a .NET Supported cell cites no tests",
    ]);
  });

  it("rejects a .NET Supported cell that cites a pattern instead of executed evidence", () => {
    expect(dotnetEvidenceProblems([row({ file: test.file, pattern: "enqueue" })], state)).toEqual([
      "Probe: a .NET Supported cell must cite protocol/v1 fixtures or a test method",
    ]);
  });

  it("rejects a .NET Supported cell that cites no fixtures", () => {
    expect(dotnetEvidenceProblems([row({ fixtures: [] })], state)).toEqual([
      "Probe: a .NET Supported cell cites no fixtures",
    ]);
  });

  it("rejects a fixture that protocol/v1 does not declare", () => {
    expect(dotnetEvidenceProblems([row({ fixtures: ["scenarios/invented"] })], state)).toEqual([
      "Probe: scenarios/invented is not a protocol/v1 fixture",
    ]);
  });

  it("rejects a fixture the .NET runner lists as expected unsupported", () => {
    expect(
      dotnetEvidenceProblems([row({ fixtures: ["runtime/priority-ordered-mixed-batch"] })], {
        ...state,
        unsupported: new Map([["runtime/priority-ordered-mixed-batch", "SM-1621"]]),
      }),
    ).toEqual([
      "Probe: runtime/priority-ordered-mixed-batch is expected unsupported in the .NET lane (SM-1621), so the cell cannot be Supported",
    ]);
  });

  it("reads only Fact and Theory methods that the default run runs, and only in the projects that run", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dotnet-parity-evidence-"));
    cpSync(path.join(repositoryRoot, "protocol/v1"), path.join(root, "protocol/v1"), {
      recursive: true,
    });
    const conformance = path.join(root, "dotnet/tests/Workhorse.Tests/Conformance");
    mkdirSync(conformance, { recursive: true });
    writeFileSync(path.join(conformance, "expected-unsupported.json"), '{"fixtures": []}');
    writeFileSync(
      path.join(conformance, "ProbeTests.cs"),
      [
        "public sealed class ProbeTests",
        "{",
        "    [Fact]",
        "    public async Task Runs()",
        "    [Theory]",
        '    [InlineData("a")]',
        "    public void Varies(string value)",
        '    [Fact(Skip = "flaky")]',
        "    public void Skipped()",
        "    [Fact(Explicit = true)]",
        "    public void Explicit()",
        "    public void Helper()",
        "}",
      ].join("\n"),
    );
    const other = path.join(root, "dotnet/tests/Other.Tests");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      path.join(other, "OtherTests.cs"),
      ["    [Fact]", "    public void Runs()"].join("\n"),
    );
    const probe = readDotnetEvidenceState(root, ["dotnet/tests/Workhorse.Tests"]);
    expect([...(probe.tests.get("Workhorse.Tests/Conformance/ProbeTests.cs") ?? [])]).toEqual([
      "Runs",
      "Varies",
    ]);
    expect(probe.tests.has("Other.Tests/OtherTests.cs")).toBe(false);
  });

  it("leaves a Planned .NET cell alone", () => {
    expect(dotnetEvidenceProblems([row({ planned: "SM-1625" })], state)).toEqual([]);
  });
});
