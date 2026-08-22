import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PARITY_TABLES,
  PARITY_TEST_ROOTS,
  type ParityCell,
  type ParityLanguage,
  type ParityRow,
} from "./support/parity-capabilities.js";

// docs/parity.md is the authoritative per-language support matrix, and it used to be the only
// place that knowledge lived. This file makes it a checked claim: the markdown tables and the
// registry in support/parity-capabilities.ts must agree cell for cell, and every Supported cell
// must name a test file in that language which actually exists and actually mentions the
// capability. Absent cells are recorded too, so shipping a capability without flipping its cell
// fails here rather than going unnoticed.

const repository = path.resolve(import.meta.dirname, "../../..");
const languages: readonly ParityLanguage[] = ["typescript", "python", "go"];

type Status = "Supported" | "Planned" | "Absent";

interface DocumentedRow {
  capability: string;
  statuses: Record<ParityLanguage, Status>;
}

/**
 * Read the three capability tables out of the markdown.
 *
 * Parsing the document rather than importing a generated copy is the point: the file a human edits
 * is the file this test reads.
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
  return "absent" in cell ? "Absent" : "Supported";
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

const markdown = await readFile(path.join(repository, "docs", "parity.md"), "utf8");
const tables = documentedTables(markdown);

const registryCells: Array<{ row: ParityRow; language: ParityLanguage }> = PARITY_TABLES.flatMap(
  (table) => table.flatMap((row) => languages.map((language) => ({ row, language }))),
);
const supportedCells = registryCells.filter(({ row, language }) => !("absent" in row[language]));

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
      const evidence = cell.row[cell.language];
      if ("absent" in evidence) throw new Error("filtered above");
      const file = path.join(repository, PARITY_TEST_ROOTS[cell.language], evidence.file);
      expect(await exists(file), `${evidence.file} does not exist`).toBe(true);
      expect(
        new RegExp(evidence.pattern).test(await readFile(file, "utf8")),
        `${evidence.file} never mentions /${evidence.pattern}/`,
      ).toBe(true);
    },
  );

  it("records a reason for every Absent cell", () => {
    const unexplained = registryCells
      .filter(({ row, language }) => "absent" in row[language])
      .filter(({ row, language }) => {
        const cell = row[language];
        return !("absent" in cell) || cell.absent.trim().length === 0;
      });
    expect(unexplained).toEqual([]);
  });

  it("claims nothing for a language the repository does not test", () => {
    // A Planned cell has no evidence shape yet. If one appears, decide what proves it before this
    // check starts silently accepting the status.
    const planned = tables.flat().flatMap((row) =>
      languages
        .filter((language) => row.statuses[language] === "Planned")
        .map((language) => ({
          capability: row.capability,
          language,
        })),
    );
    expect(planned).toEqual([]);
  });
});
