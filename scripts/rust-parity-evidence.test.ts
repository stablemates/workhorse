import { describe, expect, it } from "vitest";

import {
  PARITY_TABLES,
  type ParityRow,
} from "../typescript/core/test/support/parity-capabilities.js";
import { repositoryRoot } from "./packages.js";
import { readRustFixtureState, rustEvidenceProblems } from "./rust-parity-evidence.js";

const state = readRustFixtureState(repositoryRoot);

function row(rust: unknown): ParityRow {
  const planned = { planned: "SM-1" };
  return {
    capability: "Probe",
    typescript: planned,
    python: planned,
    go: planned,
    rust: rust as ParityRow["rust"],
  };
}

describe("Rust parity evidence", () => {
  it("accepts every Rust cell the registry declares", () => {
    expect(rustEvidenceProblems(PARITY_TABLES.flat(), state)).toEqual([]);
  });

  it("reads the declared fixtures and an empty expected-unsupported list", () => {
    expect(state.declared.has("interpreter/matcher-semantics")).toBe(true);
    expect(state.declared.has("failures/undeclared-name")).toBe(true);
    expect(state.unsupported.size).toBe(0);
  });

  it("rejects a Rust Supported cell that cites a pattern instead of executed evidence", () => {
    expect(
      rustEvidenceProblems(
        [row({ file: "protocol_conformance.rs", pattern: "enqueue_batch" })],
        state,
      ),
    ).toEqual([
      "Probe: a Rust Supported cell must cite protocol/v1 fixtures or an integration test",
    ]);
  });

  it("accepts a test function that pnpm rust:integration runs", () => {
    expect(
      rustEvidenceProblems(
        [
          row({
            file: "protocol_conformance.rs",
            test: "every_protocol_fixture_passes_or_is_listed",
          }),
        ],
        state,
      ),
    ).toEqual([]);
  });

  it("rejects a test file that pnpm rust:integration does not run", () => {
    expect(
      rustEvidenceProblems(
        [row({ file: "client.rs", test: "request_serializes_protocol_fields" })],
        state,
      ),
    ).toEqual(["Probe: pnpm rust:integration does not run client.rs"]);
  });

  it("rejects a name that is not a test function in the file", () => {
    // `scratch_database` appears in the file, but as a helper call rather than a test.
    expect(
      rustEvidenceProblems([row({ file: "postgres.rs", test: "scratch_database" })], state),
    ).toEqual(["Probe: postgres.rs has no test function scratch_database"]);
  });

  it("rejects a Rust Supported cell that cites no fixtures", () => {
    expect(rustEvidenceProblems([row({ fixtures: [] })], state)).toEqual([
      "Probe: a Rust Supported cell cites no fixtures",
    ]);
  });

  it("rejects a fixture that protocol/v1 does not declare", () => {
    expect(rustEvidenceProblems([row({ fixtures: ["scenarios/invented"] })], state)).toEqual([
      "Probe: scenarios/invented is not a protocol/v1 fixture",
    ]);
  });

  it("rejects a fixture the Rust runner lists as expected unsupported", () => {
    const listed = "runtime/durable-wait-suspension-and-checkpoint-replay";
    const ledger = { ...state, unsupported: new Map([[listed, "SM-1"]]) };
    expect(rustEvidenceProblems([row({ fixtures: [listed] })], ledger)).toEqual([
      `Probe: ${listed} is expected unsupported in Rust (SM-1), so the cell cannot be Supported`,
    ]);
  });

  it("leaves Planned and Absent Rust cells alone", () => {
    expect(
      rustEvidenceProblems([row({ planned: "SM-877" }), row({ absent: "out of scope" })], state),
    ).toEqual([]);
  });
});
