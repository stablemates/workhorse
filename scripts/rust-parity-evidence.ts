import { readFileSync } from "node:fs";
import path from "node:path";

import type { ParityRow } from "../typescript/core/test/support/parity-capabilities.js";

/**
 * The rule behind every Rust Supported cell in `docs/parity.md`.
 *
 * A Rust cell cites executed evidence rather than a pattern in a test file. The Rust conformance
 * runner executes every `protocol/v1` fixture and fails when one outside its expected-unsupported
 * list does not pass. A cited fixture that exists and is not on that list therefore passed in the
 * last green run. A cell may instead name one test function in a target that `pnpm rust:integration`
 * runs. That script requires a database, so the named test cannot skip there.
 */

/** Fixture files in `protocol/v1`, keyed by the category the Rust runner's list uses. */
const categories = [
  "compatibility",
  "contracts",
  "cron-occurrences",
  "failures",
  "interpreter",
  "requests",
  "runtime",
  "scenarios",
  "schedules",
] as const;

export interface RustFixtureState {
  /** Every `<category>/<fixture id>` that `protocol/v1` declares. */
  declared: ReadonlySet<string>;
  /** Every fixture on `rust/tests/conformance/expected-unsupported.json`, with its Issue. */
  unsupported: ReadonlyMap<string, string>;
  /** Test function names in each `rust/tests` file that `pnpm rust:integration` runs. */
  integrationTests: ReadonlyMap<string, ReadonlySet<string>>;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function readRustFixtureState(root: string): RustFixtureState {
  const declared = new Set<string>();
  for (const category of categories) {
    const document = readJson(path.join(root, "protocol/v1", `${category}.json`));
    // `failures.json` wraps its fixtures beside the envelope they share.
    const fixtures = (
      category === "failures" ? (document as { fixtures: unknown }).fixtures : document
    ) as { id: string }[];
    for (const fixture of fixtures) declared.add(`${category}/${fixture.id}`);
  }
  const ledger = readJson(path.join(root, "rust/tests/conformance/expected-unsupported.json")) as {
    fixtures: { fixture: string; issue: string }[];
  };
  return {
    declared,
    unsupported: new Map(ledger.fixtures.map((entry) => [entry.fixture, entry.issue])),
    integrationTests: readIntegrationTests(root),
  };
}

function readIntegrationTests(root: string): Map<string, Set<string>> {
  const manifest = readJson(path.join(root, "package.json")) as {
    scripts: Record<string, string>;
  };
  const script = manifest.scripts["rust:integration"] ?? "";
  const tests = new Map<string, Set<string>>();
  for (const [, target] of script.matchAll(/--test (\S+)/g)) {
    const source = readFileSync(path.join(root, "rust/tests", `${target}.rs`), "utf8");
    // A test function is a `#[test]` or `#[tokio::test]` attribute followed by its `fn`.
    const names = [
      ...source.matchAll(/^#\[(?:tokio::)?test(?:\(.*\))?\]\s*(?:async\s+)?fn\s+(\w+)/gm),
    ].map(([, name]) => name!);
    tests.set(`${target}.rs`, new Set(names));
  }
  return tests;
}

/** Name every Rust Supported cell that executed fixture evidence does not back. */
export function rustEvidenceProblems(
  rows: readonly ParityRow[],
  state: RustFixtureState,
): string[] {
  const problems: string[] = [];
  for (const row of rows) {
    const cell = row.rust;
    if (cell === undefined || "absent" in cell || "planned" in cell) continue;
    if ("file" in cell && "test" in cell && typeof cell.test === "string") {
      const tests = state.integrationTests.get(cell.file);
      if (tests === undefined) {
        problems.push(`${row.capability}: pnpm rust:integration does not run ${cell.file}`);
      } else if (!tests.has(cell.test)) {
        problems.push(`${row.capability}: ${cell.file} has no test function ${cell.test}`);
      }
      continue;
    }
    if (!("fixtures" in cell) || !Array.isArray(cell.fixtures)) {
      problems.push(
        `${row.capability}: a Rust Supported cell must cite protocol/v1 fixtures or an integration test`,
      );
      continue;
    }
    if (cell.fixtures.length === 0) {
      problems.push(`${row.capability}: a Rust Supported cell cites no fixtures`);
    }
    for (const fixture of cell.fixtures) {
      if (!state.declared.has(fixture)) {
        problems.push(`${row.capability}: ${fixture} is not a protocol/v1 fixture`);
        continue;
      }
      const issue = state.unsupported.get(fixture);
      if (issue !== undefined) {
        problems.push(
          `${row.capability}: ${fixture} is expected unsupported in Rust (${issue}), so the cell cannot be Supported`,
        );
      }
    }
  }
  return problems;
}
