import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type {
  DotnetParityCell,
  ParityRow,
} from "../typescript/core/test/support/parity-capabilities.js";
import { DOTNET_TEST_PROJECTS } from "./dotnet-test.js";
import { readDeclaredFixtures } from "./rust-parity-evidence.js";

/**
 * The rule behind every .NET Supported cell in `docs/parity.md`.
 *
 * A .NET cell cites executed evidence, as a JVM cell does. The .NET conformance runner executes
 * every `protocol/v1` fixture and fails when one outside its expected-unsupported list does not
 * pass. A cited fixture that exists and is not on that list therefore passed in the last green run.
 * A cell may instead name one xUnit test method in a test project that `pnpm dotnet:test` runs. CI
 * runs that suite with `CI` set, so a database test cannot skip there. A cell can also name the C#
 * implementation beside its test, as a file and a pattern that must appear in it.
 */

export interface DotnetEvidenceState {
  /** Every `<category>/<fixture id>` that `protocol/v1` declares. */
  declared: ReadonlySet<string>;
  /** Every fixture on the .NET runner's expected-unsupported list, with its Issue. */
  unsupported: ReadonlyMap<string, string>;
  /** Test method names in each test file, keyed by its path below `dotnet/tests`. */
  tests: ReadonlyMap<string, ReadonlySet<string>>;
  /** The repository root, for implementation files. */
  root: string;
}

const testRoot = "dotnet/tests";
const ledgerPath = "dotnet/tests/Workhorse.Tests/Conformance/expected-unsupported.json";

export function readDotnetEvidenceState(
  root: string,
  projects: readonly string[] = DOTNET_TEST_PROJECTS,
): DotnetEvidenceState {
  const ledger = JSON.parse(readFileSync(path.join(root, ledgerPath), "utf8")) as {
    fixtures: { fixture: string; issue: string }[];
  };
  return {
    declared: readDeclaredFixtures(root),
    unsupported: new Map(ledger.fixtures.map((entry) => [entry.fixture, entry.issue])),
    tests: readTests(root, projects),
    root,
  };
}

/**
 * Read the methods xUnit runs: each `public` method directly under an attribute block that holds
 * `[Fact` or `[Theory`, in a `*Tests.cs` file of a project that `pnpm dotnet:test` runs. An
 * attribute block that names `Skip` or `Explicit = true` yields no test, because the default run
 * does not run it.
 */
function readTests(root: string, projects: readonly string[]): Map<string, Set<string>> {
  const tests = new Map<string, Set<string>>();
  for (const project of projects) {
    const directory = path.join(root, project);
    if (!existsSync(directory)) continue;
    const files = readdirSync(directory, { recursive: true, encoding: "utf8" }).filter(
      (file) => file.endsWith("Tests.cs") && !/(^|[\\/])(bin|obj)[\\/]/.test(file),
    );
    for (const file of files.toSorted()) {
      const lines = readFileSync(path.join(directory, file), "utf8").split("\n");
      const names = new Set<string>();
      for (const [index, line] of lines.entries()) {
        const method =
          /^\s*public\s+(?:static\s+)?(?:async\s+)?(?:Task|ValueTask|void)\s+(\w+)\(/.exec(line);
        if (method === null) continue;
        const attributes = attributesAbove(lines, index);
        if (attributes.some((attribute) => /^\[(Fact|Theory)\b/.test(attribute))) {
          // xUnit does not run a skipped test, and runs an explicit one only when asked.
          if (!attributes.some((attribute) => /\bSkip\s*=|\bExplicit\s*=\s*true/.test(attribute))) {
            names.add(method[1]!);
          }
        }
      }
      const key = path.posix.join(
        path.relative(path.join(root, testRoot), directory).split(path.sep).join("/"),
        file.split(path.sep).join("/"),
      );
      tests.set(key, names);
    }
  }
  return tests;
}

/** The attribute lines directly above line `index`. */
function attributesAbove(lines: readonly string[], index: number): string[] {
  const attributes: string[] = [];
  for (let above = index - 1; above >= 0; above--) {
    const line = lines[above]!.trim();
    if (!line.startsWith("[")) break;
    attributes.push(line);
  }
  return attributes;
}

function cellProblems(label: string, cell: DotnetParityCell, state: DotnetEvidenceState): string[] {
  if ("planned" in cell) return [];
  if ("tests" in cell) {
    if (cell.tests.length === 0) return [`${label}: a .NET Supported cell cites no tests`];
    return cell.tests.flatMap((test) => cellProblems(label, test, state));
  }
  if ("file" in cell && "test" in cell) {
    const problems: string[] = [];
    const tests = state.tests.get(cell.file);
    if (tests === undefined) problems.push(`${label}: pnpm dotnet:test does not run ${cell.file}`);
    else if (!tests.has(cell.test))
      problems.push(`${label}: ${cell.file} has no test method ${cell.test}`);
    if (cell.implementation !== undefined) {
      const file = path.join(state.root, cell.implementation.file);
      if (!existsSync(file)) {
        problems.push(`${label}: the implementation ${cell.implementation.file} does not exist`);
      } else if (!readFileSync(file, "utf8").includes(cell.implementation.pattern)) {
        problems.push(
          `${label}: ${cell.implementation.file} never mentions ${cell.implementation.pattern}`,
        );
      }
    }
    return problems;
  }
  if (!("fixtures" in cell) || !Array.isArray(cell.fixtures)) {
    return [`${label}: a .NET Supported cell must cite protocol/v1 fixtures or a test method`];
  }
  const problems: string[] = [];
  if (cell.fixtures.length === 0)
    problems.push(`${label}: a .NET Supported cell cites no fixtures`);
  for (const fixture of cell.fixtures) {
    if (!state.declared.has(fixture)) {
      problems.push(`${label}: ${fixture} is not a protocol/v1 fixture`);
      continue;
    }
    const issue = state.unsupported.get(fixture);
    if (issue !== undefined) {
      problems.push(
        `${label}: ${fixture} is expected unsupported in the .NET lane (${issue}), so the cell cannot be Supported`,
      );
    }
  }
  return problems;
}

/** Name every .NET row that lacks a cell, and every .NET Supported cell that evidence does not back. */
export function dotnetEvidenceProblems(
  rows: readonly ParityRow[],
  state: DotnetEvidenceState,
): string[] {
  return rows.flatMap((row) =>
    row.dotnet === undefined
      ? [`${row.capability}: the .NET column needs a cell`]
      : cellProblems(row.capability, row.dotnet, state),
  );
}
