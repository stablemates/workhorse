import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  PARITY_CLIENT_ROWS,
  PARITY_DEFAULT_ROWS,
  PARITY_OPERATOR_ROWS,
  PARITY_WORKER_ROWS,
  PRODUCT_PARITY_ROWS,
  type ParityCell,
  type ParityDefaultRow,
  type ParityRow,
  type RustParityCell,
} from "../typescript/core/test/support/parity-capabilities.js";
import { repositoryRoot } from "./packages.js";
import { readRustFixtureState, rustEvidenceProblems } from "./rust-parity-evidence.js";

const documentPath = path.join(repositoryRoot, "docs/parity.md");
const check = process.argv.includes("--check");

const tables = [
  ["client", PARITY_CLIENT_ROWS],
  ["worker", PARITY_WORKER_ROWS],
  ["operator", PARITY_OPERATOR_ROWS],
] as const;

const productColumns = ["PostgreSQL", "Dashboard", "CLI"] as const;

function status(cell: ParityCell | RustParityCell): string {
  if ("absent" in cell) return "Absent";
  // Reference-style so the reader reaches the Issue; the definitions are generated below.
  if ("planned" in cell) return `[Planned][${cell.planned}]`;
  return "Supported";
}

function renderCells(cells: readonly (readonly string[])[]): string {
  const widths = cells[0]!.map((_, index) => Math.max(...cells.map((row) => row[index]!.length)));
  const line = (row: readonly string[]) =>
    `| ${row.map((cell, index) => cell.padEnd(widths[index]!)).join(" | ")} |`;
  const separator = line(widths.map((width) => "-".repeat(width)));
  return [line(cells[0]!), separator, ...cells.slice(1).map(line)].join("\n");
}

function rustCell(row: ParityRow, table: "client" | "worker" | "operator"): RustParityCell {
  if (row.rust) return row.rust;
  throw new Error(`Rust ${table} row "${row.capability}" needs a cell`);
}

function renderTable(rows: readonly ParityRow[], table: "client" | "worker" | "operator"): string {
  return renderCells([
    ["Capability", "TypeScript", "Python", "Go", "Rust"],
    ...rows.map((row) => [
      row.capability,
      status(row.typescript),
      status(row.python),
      status(row.go),
      status(rustCell(row, table)),
    ]),
  ]);
}

/** A default renders its value, or Absent when the language has no such setting. */
function defaultValue(cell: ParityDefaultRow["typescript"] | ParityDefaultRow["rust"]): string {
  if (cell === undefined || "absent" in cell) return "Absent";
  if ("planned" in cell) return `[Planned][${cell.planned}]`;
  return cell.value;
}

function renderDefaultsTable(): string {
  return renderCells([
    ["Setting", "TypeScript", "Python", "Go", "Rust"],
    ...PARITY_DEFAULT_ROWS.map((row) => [
      row.setting,
      defaultValue(row.typescript),
      defaultValue(row.python),
      defaultValue(row.go),
      defaultValue(row.rust ?? { planned: "SM-878" }),
    ]),
  ]);
}

function renderProductTable(): string {
  return renderCells([
    ["Capability", ...productColumns],
    ...PRODUCT_PARITY_ROWS.map((row) => [
      row.capability,
      status(row.postgresql),
      status(row.dashboard),
      status(row.cli),
    ]),
  ]);
}

function replaceGeneratedTable(
  document: string,
  name: string,
  rows: readonly ParityRow[],
  table: "client" | "worker" | "operator",
): string {
  const start = `<!-- BEGIN GENERATED PARITY ${name.toUpperCase()} -->`;
  const end = `<!-- END GENERATED PARITY ${name.toUpperCase()} -->`;
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pattern.test(document)) throw new Error(`Missing generated parity markers for ${name}`);
  return document.replace(pattern, `${start}\n\n${renderTable(rows, table)}\n\n${end}`);
}

// Both modes refuse a Rust Supported cell that the conformance runner does not back.
const rustProblems = rustEvidenceProblems(
  tables.flatMap(([, rows]) => rows),
  readRustFixtureState(repositoryRoot),
);
if (rustProblems.length > 0) {
  throw new Error(`Rust parity cells lack executed evidence:\n${rustProblems.join("\n")}`);
}

const current = await readFile(documentPath, "utf8");
const generatedLanguages = tables.reduce(
  (document, [name, rows]) => replaceGeneratedTable(document, name, rows, name),
  current,
);
const defaultsStart = "<!-- BEGIN GENERATED PARITY DEFAULTS -->";
const defaultsEnd = "<!-- END GENERATED PARITY DEFAULTS -->";
const defaultsPattern = new RegExp(`${defaultsStart}[\\s\\S]*?${defaultsEnd}`);
if (!defaultsPattern.test(generatedLanguages)) {
  throw new Error("Missing generated parity markers for defaults");
}
const generatedDefaults = generatedLanguages.replace(
  defaultsPattern,
  `${defaultsStart}\n\n${renderDefaultsTable()}\n\n${defaultsEnd}`,
);
const productStart = "<!-- BEGIN GENERATED PARITY PRODUCT -->";
const productEnd = "<!-- END GENERATED PARITY PRODUCT -->";
const productPattern = new RegExp(`${productStart}[\\s\\S]*?${productEnd}`);
if (!productPattern.test(generatedDefaults)) {
  throw new Error("Missing generated parity markers for product");
}
const generated = generatedDefaults.replace(
  productPattern,
  `${productStart}\n\n${renderProductTable()}\n\n${productEnd}`,
);
const plannedItems = [
  ...new Set(
    [
      ...tables.flatMap(([name, rows]) =>
        rows.flatMap((row) => [row.typescript, row.python, row.go, rustCell(row, name)]),
      ),
      ...PRODUCT_PARITY_ROWS.flatMap((row) => [row.postgresql, row.dashboard, row.cli]),
      ...PARITY_DEFAULT_ROWS.map((row) => row.rust ?? { planned: "SM-878" }),
    ].flatMap((cell) => ("planned" in cell ? [cell.planned] : [])),
  ),
].toSorted();
const plannedStart = "<!-- BEGIN GENERATED PARITY LINEAR LINKS -->";
const plannedEnd = "<!-- END GENERATED PARITY LINEAR LINKS -->";
const plannedPattern = new RegExp(`${plannedStart}[\\s\\S]*?${plannedEnd}`);
if (!plannedPattern.test(generated)) {
  throw new Error("Missing generated parity Linear link markers");
}
// Prettier surrounds link definitions with blank lines, so emit them the same way or the two
// rewrite each other forever. With no Planned cell there is nothing to separate.
const linkDefinitions = plannedItems.map(
  (item) => `[${item}]: https://linear.app/stablemates/issue/${item}`,
);
const withLinks = generated.replace(
  plannedPattern,
  linkDefinitions.length === 0
    ? `${plannedStart}\n${plannedEnd}`
    : `${plannedStart}\n\n${linkDefinitions.join("\n")}\n\n${plannedEnd}`,
);

if (check) {
  if (withLinks !== current) {
    throw new Error("docs/parity.md is stale; run pnpm parity:generate");
  }
} else {
  await writeFile(documentPath, withLinks);
}
