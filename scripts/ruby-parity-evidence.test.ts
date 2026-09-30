import { describe, expect, it } from "vitest";

import {
  ACTIVE_JOB_PARITY_ROWS,
  PARITY_CLIENT_ROWS,
  PARITY_TABLES,
  PARITY_WORKER_ROWS,
  type ActiveJobParityRow,
  type ParityRow,
} from "../typescript/core/test/support/parity-capabilities.js";
import { repositoryRoot } from "./packages.js";
import {
  activeJobEvidenceProblems,
  readRubyEvidenceState,
  rubyEvidenceProblems,
} from "./ruby-parity-evidence.js";

const state = readRubyEvidenceState(repositoryRoot);
const nativeRows = [...PARITY_CLIENT_ROWS, ...PARITY_WORKER_ROWS];
const example = {
  file: "integration/enqueue_spec.rb",
  example: "persists run at, priority, tags, and max attempts",
};

function row(ruby: unknown, capability = "Probe"): ParityRow {
  const planned = { planned: "SM-1" };
  return {
    capability,
    typescript: planned,
    python: planned,
    go: planned,
    rust: planned,
    ruby: ruby as ParityRow["ruby"],
  };
}

function activeJob(capability: string, cell: unknown): ActiveJobParityRow {
  const typed = cell as ActiveJobParityRow["typedJob"];
  return { capability, defaultJob: { nativeOnly: "no option" }, typedJob: typed };
}

describe("Ruby parity evidence", () => {
  it("accepts every Ruby cell the registry declares", () => {
    expect(rubyEvidenceProblems(PARITY_TABLES.flat(), state)).toEqual([]);
  });

  it("accepts every Active Job cell the registry declares", () => {
    expect(activeJobEvidenceProblems(ACTIVE_JOB_PARITY_ROWS, nativeRows, state)).toEqual([]);
  });

  it("reads the declared fixtures, the expected-unsupported list, and the spec examples", () => {
    expect(state.declared.has("scenarios/fast-tier")).toBe(true);
    expect(state.unsupported.get("runtime/lease-loss-fences-handler-writes")).toBe("SM-981");
    expect(state.examples.get(example.file)?.has(example.example)).toBe(true);
  });

  it("accepts an example that pnpm ruby:test runs", () => {
    expect(rubyEvidenceProblems([row(example)], state)).toEqual([]);
  });

  it("rejects a file that pnpm ruby:test does not run", () => {
    expect(rubyEvidenceProblems([row({ ...example, file: "enqueue_spec.rb" })], state)).toEqual([
      "Probe: pnpm ruby:test does not run enqueue_spec.rb",
    ]);
  });

  it("rejects a name that is not an example in the file", () => {
    expect(
      rubyEvidenceProblems([row({ file: example.file, example: "persists run at" })], state),
    ).toEqual([`Probe: ${example.file} has no example "persists run at"`]);
  });

  it("rejects a Ruby Supported cell that cites a pattern instead of executed evidence", () => {
    expect(rubyEvidenceProblems([row({ file: example.file, pattern: "enqueue" })], state)).toEqual([
      "Probe: a Ruby Supported cell must cite protocol/v1 fixtures or a spec example",
    ]);
  });

  it("rejects a Ruby Supported cell that cites no fixtures", () => {
    expect(rubyEvidenceProblems([row({ fixtures: [] })], state)).toEqual([
      "Probe: a Ruby Supported cell cites no fixtures",
    ]);
  });

  it("rejects a fixture that protocol/v1 does not declare", () => {
    expect(rubyEvidenceProblems([row({ fixtures: ["scenarios/invented"] })], state)).toEqual([
      "Probe: scenarios/invented is not a protocol/v1 fixture",
    ]);
  });

  it("rejects a fixture the Ruby runner lists as expected unsupported", () => {
    expect(
      rubyEvidenceProblems(
        [row({ fixtures: ["runtime/lease-loss-fences-handler-writes"] })],
        state,
      ),
    ).toEqual([
      "Probe: runtime/lease-loss-fences-handler-writes is expected unsupported in Ruby (SM-981), so the cell cannot be Supported",
    ]);
  });

  it("leaves Planned and Absent Ruby cells alone", () => {
    expect(
      rubyEvidenceProblems([row({ planned: "SM-900" }), row({ absent: "out of scope" })], state),
    ).toEqual([]);
  });

  it("rejects an Active Job capability that no native row declares", () => {
    expect(
      activeJobEvidenceProblems([activeJob("Invented", { planned: "SM-902" })], nativeRows, state),
    ).toEqual(["Active Job Invented: no Client or Worker row has this capability"]);
  });

  it("rejects a Supported Active Job cell whose native Ruby cell is not Supported", () => {
    const native = [row({ planned: "SM-900" }, "Probe")];
    expect(activeJobEvidenceProblems([activeJob("Probe", example)], native, state)).toEqual([
      "Active Job Probe (typed job): the native Ruby cell is not Supported, so this cell cannot be",
    ]);
  });

  it("checks the evidence of a Supported Active Job cell", () => {
    const native = [row(example, "Probe")];
    expect(
      activeJobEvidenceProblems([activeJob("Probe", { fixtures: [] })], native, state),
    ).toEqual(["Active Job Probe (typed job): a Ruby Supported cell cites no fixtures"]);
  });

  it("rejects a Native only cell without a reason", () => {
    const native = [row(example, "Probe")];
    expect(
      activeJobEvidenceProblems([activeJob("Probe", { nativeOnly: " " })], native, state),
    ).toEqual(["Active Job Probe (typed job): a Native only cell records no reason"]);
  });
});
