import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type {
  JvmParityCell,
  ParityRow,
} from "../typescript/core/test/support/parity-capabilities.js";
import { readDeclaredFixtures } from "./rust-parity-evidence.js";

/**
 * The rule behind every JVM Supported cell in `docs/parity.md`.
 *
 * A JVM cell cites executed evidence, as a Ruby cell does. The JVM conformance runner executes
 * every `protocol/v1` fixture and fails when one outside its expected-unsupported list does not
 * pass. A cited fixture that exists and is not on that list therefore passed in the last green run.
 * A cell may instead name one JUnit test method in a `jvm/workhorse/src/test/java` file that
 * `pnpm jvm:test` runs. CI runs that suite with `WORKHORSE_REQUIRE_DATABASE=1`, so a database test
 * cannot skip there.
 */

export interface JvmEvidenceState {
  /** Every `<category>/<fixture id>` that `protocol/v1` declares. */
  declared: ReadonlySet<string>;
  /** Every fixture on the JVM runner's expected-unsupported list, with its Issue. */
  unsupported: ReadonlyMap<string, string>;
  /** Test method names in each test file, keyed by its path below `jvm/workhorse/src/test/java`. */
  tests: ReadonlyMap<string, ReadonlySet<string>>;
}

const testRoot = "jvm/workhorse/src/test/java";
const ledgerPath = "jvm/workhorse/src/test/resources/conformance/expected-unsupported.json";

export function readJvmEvidenceState(root: string): JvmEvidenceState {
  const ledger = JSON.parse(readFileSync(path.join(root, ledgerPath), "utf8")) as {
    fixtures: { fixture: string; issue: string }[];
  };
  return {
    declared: readDeclaredFixtures(root),
    unsupported: new Map(ledger.fixtures.map((entry) => [entry.fixture, entry.issue])),
    tests: readTests(path.join(root, testRoot)),
  };
}

/**
 * Read the methods JUnit runs: each `void` method directly under an annotation block that holds
 * `@Test`. A file that names `@Disabled` anywhere yields no test. An annotation can span lines, so
 * the rule does not try to place it; it never accepts a disabled test.
 */
function readTests(directory: string): Map<string, Set<string>> {
  const tests = new Map<string, Set<string>>();
  const files = readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((file) =>
    file.endsWith("Test.java"),
  );
  for (const file of files.toSorted()) {
    const lines = readFileSync(path.join(directory, file), "utf8").split("\n");
    const names = new Set<string>();
    if (!lines.some((line) => /@Disabled\b/.test(line))) {
      for (const [index, line] of lines.entries()) {
        const method = /^\s*(?:(?:public|protected|private|static|final)\s+)*void (\w+)\(/.exec(
          line,
        );
        if (method !== null && annotationsAbove(lines, index).includes("@Test")) {
          names.add(method[1]!);
        }
      }
    }
    tests.set(file.split(path.sep).join("/"), names);
  }
  return tests;
}

/** The annotation names on the lines directly above line `index`. */
function annotationsAbove(lines: readonly string[], index: number): string[] {
  const annotations: string[] = [];
  for (let above = index - 1; above >= 0; above--) {
    const match = /^\s*(@\w+)/.exec(lines[above]!);
    if (match === null) break;
    annotations.push(match[1]!);
  }
  return annotations;
}

function cellProblems(label: string, cell: JvmParityCell, state: JvmEvidenceState): string[] {
  if ("planned" in cell) return [];
  if ("file" in cell && "test" in cell) {
    const tests = state.tests.get(cell.file);
    if (tests === undefined) return [`${label}: pnpm jvm:test does not run ${cell.file}`];
    return tests.has(cell.test) ? [] : [`${label}: ${cell.file} has no test method ${cell.test}`];
  }
  if (!("fixtures" in cell) || !Array.isArray(cell.fixtures)) {
    return [`${label}: a JVM Supported cell must cite protocol/v1 fixtures or a test method`];
  }
  const problems: string[] = [];
  if (cell.fixtures.length === 0) problems.push(`${label}: a JVM Supported cell cites no fixtures`);
  for (const fixture of cell.fixtures) {
    if (!state.declared.has(fixture)) {
      problems.push(`${label}: ${fixture} is not a protocol/v1 fixture`);
      continue;
    }
    const issue = state.unsupported.get(fixture);
    if (issue !== undefined) {
      problems.push(
        `${label}: ${fixture} is expected unsupported in the JVM lane (${issue}), so the cell cannot be Supported`,
      );
    }
  }
  return problems;
}

/** Name every JVM row that lacks a cell, and every JVM Supported cell that evidence does not back. */
export function jvmEvidenceProblems(rows: readonly ParityRow[], state: JvmEvidenceState): string[] {
  return rows.flatMap((row) =>
    row.jvm === undefined
      ? [`${row.capability}: the JVM column needs a cell`]
      : cellProblems(row.capability, row.jvm, state),
  );
}
