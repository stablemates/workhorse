import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type {
  ActiveJobParityCell,
  ActiveJobParityRow,
  ParityRow,
  RubyParityCell,
} from "../typescript/core/test/support/parity-capabilities.js";
import { readDeclaredFixtures } from "./rust-parity-evidence.js";

/**
 * The rule behind every Ruby Supported cell in `docs/parity.md`.
 *
 * A Ruby cell cites executed evidence, as a Rust cell does. The Ruby conformance runner executes
 * every `protocol/v1` fixture and fails when one outside its expected-unsupported list does not
 * pass. A cited fixture that exists and is not on that list therefore passed in the last green run.
 * A cell may instead name one example in a `ruby/spec` file that `pnpm ruby:test` runs. CI runs
 * that suite with `WORKHORSE_REQUIRE_DATABASE=1`, so the named example cannot skip there.
 */

export interface RubyEvidenceState {
  /** Every `<category>/<fixture id>` that `protocol/v1` declares. */
  declared: ReadonlySet<string>;
  /** Every fixture on `ruby/spec/conformance/expected-unsupported.json`, with its Issue. */
  unsupported: ReadonlyMap<string, string>;
  /** Example descriptions in each `ruby/spec` file, keyed by its path below `ruby/spec`. */
  examples: ReadonlyMap<string, ReadonlySet<string>>;
}

const specRoot = "ruby/spec";

export function readRubyEvidenceState(root: string): RubyEvidenceState {
  const ledger = JSON.parse(
    readFileSync(path.join(root, specRoot, "conformance/expected-unsupported.json"), "utf8"),
  ) as { fixtures: { fixture: string; issue: string }[] };
  return {
    declared: readDeclaredFixtures(root),
    unsupported: new Map(ledger.fixtures.map((entry) => [entry.fixture, entry.issue])),
    examples: readExamples(path.join(root, specRoot)),
  };
}

/** Read the files `rake test` loads: the RSpec default pattern, `spec/**\/*_spec.rb`. */
function readExamples(directory: string): Map<string, Set<string>> {
  const examples = new Map<string, Set<string>>();
  const files = readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((file) =>
    file.endsWith("_spec.rb"),
  );
  for (const file of files.toSorted()) {
    const source = readFileSync(path.join(directory, file), "utf8");
    // Only `it`: `xit`, `skip`, and `pending` examples never pass, so they cannot back a cell.
    const names = [...source.matchAll(/^\s*it "([^"]+)"(?: do|,)/gm)].map(([, name]) => name!);
    examples.set(file.split(path.sep).join("/"), new Set(names));
  }
  return examples;
}

type RubyCell = RubyParityCell | ActiveJobParityCell;

function cellProblems(label: string, cell: RubyCell, state: RubyEvidenceState): string[] {
  if ("absent" in cell || "planned" in cell || "nativeOnly" in cell) return [];
  if ("file" in cell && "example" in cell && typeof cell.example === "string") {
    const examples = state.examples.get(cell.file);
    if (examples === undefined) return [`${label}: pnpm ruby:test does not run ${cell.file}`];
    return examples.has(cell.example)
      ? []
      : [`${label}: ${cell.file} has no example "${cell.example}"`];
  }
  if (!("fixtures" in cell) || !Array.isArray(cell.fixtures)) {
    return [`${label}: a Ruby Supported cell must cite protocol/v1 fixtures or a spec example`];
  }
  const problems: string[] = [];
  if (cell.fixtures.length === 0)
    problems.push(`${label}: a Ruby Supported cell cites no fixtures`);
  for (const fixture of cell.fixtures) {
    if (!state.declared.has(fixture)) {
      problems.push(`${label}: ${fixture} is not a protocol/v1 fixture`);
      continue;
    }
    const issue = state.unsupported.get(fixture);
    if (issue !== undefined) {
      problems.push(
        `${label}: ${fixture} is expected unsupported in Ruby (${issue}), so the cell cannot be Supported`,
      );
    }
  }
  return problems;
}

function supported(cell: RubyCell): boolean {
  return !("absent" in cell || "planned" in cell || "nativeOnly" in cell);
}

/** Name every Ruby Supported cell that executed evidence does not back. */
export function rubyEvidenceProblems(
  rows: readonly ParityRow[],
  state: RubyEvidenceState,
): string[] {
  return rows.flatMap((row) => cellProblems(row.capability, row.ruby, state));
}

/**
 * Name every Active Job cell that its evidence, or the native Ruby row it names, does not back.
 *
 * An Active Job job reaches a capability through the native SDK, so a cell cannot be Supported
 * while the native Ruby cell is not.
 */
export function activeJobEvidenceProblems(
  rows: readonly ActiveJobParityRow[],
  nativeRows: readonly ParityRow[],
  state: RubyEvidenceState,
): string[] {
  const problems: string[] = [];
  for (const row of rows) {
    const native = nativeRows.find((candidate) => candidate.capability === row.capability);
    if (native === undefined) {
      problems.push(`Active Job ${row.capability}: no Client or Worker row has this capability`);
      continue;
    }
    for (const [format, cell] of [
      ["default job", row.defaultJob],
      ["typed job", row.typedJob],
    ] as const) {
      const label = `Active Job ${row.capability} (${format})`;
      if ("nativeOnly" in cell && cell.nativeOnly.trim().length === 0) {
        problems.push(`${label}: a Native only cell records no reason`);
      }
      problems.push(...cellProblems(label, cell, state));
      if (supported(cell) && !supported(native.ruby)) {
        problems.push(`${label}: the native Ruby cell is not Supported, so this cell cannot be`);
      }
    }
  }
  return problems;
}
