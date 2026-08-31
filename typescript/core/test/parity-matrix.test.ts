import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PARITY_TABLES,
  PARITY_TEST_ROOTS,
  PRODUCT_PARITY_ROWS,
  PRODUCT_PARITY_TEST_ROOTS,
  type ParityCell,
  type ParityLanguage,
  type ParityRow,
  type ProductParityTarget,
} from "./support/parity-capabilities.js";

// The registry in support/parity-capabilities.ts owns the per-language support matrix, while the
// generated docs/parity.md publishes it. These tests validate the rendered artifact and require
// every Supported cell to name a test file that exists and mentions the capability. Absent cells
// are recorded too, so shipping a capability without flipping its cell fails here.

const repository = path.resolve(import.meta.dirname, "../../..");
const languages: readonly ParityLanguage[] = ["typescript", "python", "go"];
const productTargets: readonly ProductParityTarget[] = ["postgresql", "dashboard", "cli"];

type Status = "Supported" | "Planned" | "Absent";

interface DocumentedRow {
  capability: string;
  statuses: Record<ParityLanguage, Status>;
}

/**
 * Read the three capability tables out of the markdown.
 *
 * Parse the generated document to verify that readers see every registry row and status.
 */
function documentedTables(markdown: string): DocumentedRow[][] {
  const tables: DocumentedRow[][] = [];
  let current: DocumentedRow[] | null = null;
  for (const line of markdown.split("\n")) {
    if (/^\|\s*Capability\s*\|\s*TypeScript\s*\|\s*Python\s*\|\s*Go\s*\|$/.test(line)) {
      current = [];
      tables.push(current);
      continue;
    }
    if (current === null) continue;
    if (!line.startsWith("|")) {
      current = null;
      continue;
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 4 || /^-+$/.test(cells[0]!)) continue;
    const [capability, ...statuses] = cells as [string, Status, Status, Status];
    current.push({
      capability,
      statuses: { typescript: statuses[0], python: statuses[1], go: statuses[2] },
    });
  }
  return tables;
}

function statusOf(cell: ParityCell): Status {
  if ("absent" in cell) return "Absent";
  if ("planned" in cell) return "Planned";
  return "Supported";
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function expectEvidence(root: string, evidence: ParityCell): Promise<void> {
  if (!("file" in evidence)) throw new Error("expected Supported evidence");
  const file = path.join(repository, root, evidence.file);
  expect(await exists(file), `${evidence.file} does not exist`).toBe(true);
  const contents = await readFile(file, "utf8");
  const patterns = "patterns" in evidence ? evidence.patterns : [evidence.pattern];
  expect(patterns.length, `${evidence.file} names no evidence patterns`).toBeGreaterThan(0);
  for (const pattern of patterns) {
    expect(new RegExp(pattern).test(contents), `${evidence.file} never mentions /${pattern}/`).toBe(
      true,
    );
  }
}

function unexplainedAbsent(cells: readonly ParityCell[]): ParityCell[] {
  return cells.filter((cell) => "absent" in cell && cell.absent.trim().length === 0);
}

const markdown = await readFile(path.join(repository, "docs", "parity.md"), "utf8");
const tables = documentedTables(markdown);

const registryCells: Array<{ row: ParityRow; language: ParityLanguage }> = PARITY_TABLES.flatMap(
  (table) => table.flatMap((row) => languages.map((language) => ({ row, language }))),
);
const supportedCells = registryCells.filter(
  ({ row, language }) => statusOf(row[language]) === "Supported",
);
const productCells = PRODUCT_PARITY_ROWS.flatMap((row) =>
  productTargets.map((target) => ({ row, target })),
);
const supportedProductCells = productCells.filter(
  ({ row, target }) => statusOf(row[target]) === "Supported",
);

describe("parity matrix", () => {
  it("finds the three documented capability tables", () => {
    expect(tables).toHaveLength(PARITY_TABLES.length);
  });

  it.each(PARITY_TABLES.map((table, index) => [index, table] as const))(
    "table %i lists the same capabilities as the registry, in the same order",
    (index, table) => {
      expect(tables[index]?.map((row) => row.capability)).toEqual(
        table.map((row) => row.capability),
      );
    },
  );

  it.each(registryCells.map((cell) => [cell.row.capability, cell.language, cell] as const))(
    "%s / %s has the same status in the document and the registry",
    (unusedCapability, unusedLanguage, cell) => {
      const table = PARITY_TABLES.findIndex((rows) => rows.includes(cell.row));
      const documented = tables[table]?.find((row) => row.capability === cell.row.capability)
        ?.statuses[cell.language];
      expect(documented).toBe(statusOf(cell.row[cell.language]));
    },
  );

  it.each(supportedCells.map((cell) => [cell.row.capability, cell.language, cell] as const))(
    "%s / %s names evidence that exists",
    async (unusedCapability, unusedLanguage, cell) => {
      expect.hasAssertions();
      await expectEvidence(PARITY_TEST_ROOTS[cell.language], cell.row[cell.language]);
    },
  );

  it("records a reason for every Absent cell", () => {
    expect(unexplainedAbsent(registryCells.map(({ row, language }) => row[language]))).toEqual([]);
  });

  it("lists the product operator capabilities and statuses from the registry", () => {
    const productTable = markdown.match(
      /\|\s*Capability\s*\|\s*PostgreSQL\s*\|\s*Dashboard\s*\|\s*CLI\s*\|[\s\S]*?(?=\n\n)/,
    )?.[0];
    expect(productTable).toBeDefined();
    for (const row of PRODUCT_PARITY_ROWS) {
      const documented = productTable
        ?.split("\n")
        .find((line) => line.includes(`| ${row.capability}`));
      expect(documented).toBeDefined();
      for (const target of productTargets) {
        expect(documented).toContain(statusOf(row[target]));
      }
    }
  });

  it.each(supportedProductCells.map((cell) => [cell.row.capability, cell.target, cell] as const))(
    "%s / %s names product evidence that exists",
    async (_capability, _target, cell) => {
      expect.hasAssertions();
      await expectEvidence(PRODUCT_PARITY_TEST_ROOTS[cell.target], cell.row[cell.target]);
    },
  );

  it("records a reason for every Absent product cell", () => {
    expect(unexplainedAbsent(productCells.map(({ row, target }) => row[target]))).toEqual([]);
  });

  it("links the Ontrack Issue behind every Planned cell", () => {
    // A Planned cell's evidence is the open Issue that owns the gap. The document must link
    // it, so the cell cannot outlive the work it points at unnoticed.
    const unlinked = [
      ...registryCells.map(({ row, language }) => row[language]),
      ...productCells.map(({ row, target }) => row[target]),
    ]
      .filter((cell) => "planned" in cell)
      .map((cell) => ("planned" in cell ? cell.planned : ""))
      .filter(
        (item) =>
          !/^WH-\d+$/.test(item) ||
          !markdown.includes(`[${item}]: https://ontrack.sh/projects/WH/issues/${item}`),
      );
    expect(unlinked).toEqual([]);
  });
});
