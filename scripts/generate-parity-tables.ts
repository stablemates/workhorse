import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  PARITY_CLIENT_ROWS,
  PARITY_OPERATOR_ROWS,
  PARITY_WORKER_ROWS,
  PRODUCT_PARITY_ROWS,
  type ParityCell,
  type ParityRow,
} from "../typescript/core/test/support/parity-capabilities.js";
import { repositoryRoot } from "./packages.js";

const documentPath = path.join(repositoryRoot, "docs/parity.md");
const check = process.argv.includes("--check");

const tables = [
  ["client", PARITY_CLIENT_ROWS],
  ["worker", PARITY_WORKER_ROWS],
  ["operator", PARITY_OPERATOR_ROWS],
] as const;

const productColumns = ["PostgreSQL", "Dashboard", "CLI"] as const;

function status(cell: ParityCell): string {
  if ("absent" in cell) return "Absent";
  if ("planned" in cell) return "Planned";
  return "Supported";
}

function renderCells(cells: readonly (readonly string[])[]): string {
  const widths = cells[0]!.map((_, index) => Math.max(...cells.map((row) => row[index]!.length)));
  const line = (row: readonly string[]) =>
    `| ${row.map((cell, index) => cell.padEnd(widths[index]!)).join(" | ")} |`;
  const separator = line(widths.map((width) => "-".repeat(width)));
  return [line(cells[0]!), separator, ...cells.slice(1).map(line)].join("\n");
}

function renderTable(rows: readonly ParityRow[]): string {
  return renderCells([
    ["Capability", "TypeScript", "Python", "Go"],
    ...rows.map((row) => [
      row.capability,
      status(row.typescript),
      status(row.python),
      status(row.go),
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

function replaceGeneratedTable(document: string, name: string, rows: readonly ParityRow[]): string {
  const start = `<!-- BEGIN GENERATED PARITY ${name.toUpperCase()} -->`;
  const end = `<!-- END GENERATED PARITY ${name.toUpperCase()} -->`;
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pattern.test(document)) throw new Error(`Missing generated parity markers for ${name}`);
  return document.replace(pattern, `${start}\n\n${renderTable(rows)}\n\n${end}`);
}

const current = await readFile(documentPath, "utf8");
const generatedLanguages = tables.reduce(
  (document, [name, rows]) => replaceGeneratedTable(document, name, rows),
  current,
);
const productStart = "<!-- BEGIN GENERATED PARITY PRODUCT -->";
const productEnd = "<!-- END GENERATED PARITY PRODUCT -->";
const productPattern = new RegExp(`${productStart}[\\s\\S]*?${productEnd}`);
if (!productPattern.test(generatedLanguages)) {
  throw new Error("Missing generated parity markers for product");
}
const generated = generatedLanguages.replace(
  productPattern,
  `${productStart}\n\n${renderProductTable()}\n\n${productEnd}`,
);
const plannedItems = [
  ...new Set(
    [
      ...tables.flatMap(([, rows]) => rows.flatMap((row) => [row.typescript, row.python, row.go])),
      ...PRODUCT_PARITY_ROWS.flatMap((row) => [row.postgresql, row.dashboard, row.cli]),
    ].flatMap((cell) => ("planned" in cell ? [cell.planned] : [])),
  ),
].toSorted();
const plannedStart = "<!-- BEGIN GENERATED PARITY PLANE LINKS -->";
const plannedEnd = "<!-- END GENERATED PARITY PLANE LINKS -->";
const plannedPattern = new RegExp(`${plannedStart}[\\s\\S]*?${plannedEnd}`);
if (!plannedPattern.test(generated)) throw new Error("Missing generated parity Plane link markers");
const withLinks = generated.replace(
  plannedPattern,
  [
    plannedStart,
    ...plannedItems.map((item) => `[${item}]: https://app.plane.so/techprogress/browse/${item}/`),
    plannedEnd,
  ].join("\n"),
);

if (check) {
  if (withLinks !== current) {
    throw new Error("docs/parity.md is stale; run pnpm parity:generate");
  }
} else {
  await writeFile(documentPath, withLinks);
}
