import { readFile } from "node:fs/promises";
import path from "node:path";

import { publishedPackages, repositoryRoot, type PublishedPackage } from "./packages.js";
import {
  compare,
  declarationProgram,
  DeclarationCollector,
  renderBlocks,
  requireSourceFile,
} from "./typescript-declarations.js";

/**
 * The public TypeScript surface, read from the shipped declarations.
 *
 * ADR 0054 defines the TypeScript API as the names and types reachable through a package's
 * `exports` map and its shipped `.d.ts`. This module reproduces that reach. Every `exports`
 * subpath declaring `types` is an entry point, each name the entry point exports is printed as the
 * declaration a caller's compiler resolves it to, and every repository type those declarations
 * name is printed after them. The closure is what makes the snapshot complete: a public signature
 * may hold a type its own module never exports, and narrowing that type is a break the exported
 * names alone would not show.
 *
 * `scripts/typescript-declarations.ts` prints the declarations and closes over what they reach,
 * and `scripts/generate-typescript-api.ts` writes the rendering to `api/typescript.txt`.
 */

/** One `exports` subpath that ships declarations. */
export interface ApiEntry {
  /** Package name as npm knows it, for example `@stablemates/workhorse`. */
  readonly packageName: string;
  /** Subpath key from the `exports` map, for example `.` or `./wire`. */
  readonly subpath: string;
  /** Absolute path to the declaration file the subpath's `types` condition names. */
  readonly declarationFile: string;
}

interface ExportsCondition {
  readonly types?: string;
}

type ExportsMap = Readonly<Record<string, ExportsCondition | string>>;

interface Manifest {
  readonly exports?: ExportsMap;
}

/**
 * Entry points of one package, in `exports` order.
 *
 * A subpath with no `types` condition ships no declarations — `./styles.css` is the only one
 * today — so it carries no TypeScript surface and is skipped rather than rendered as empty.
 */
function entriesOf(entry: PublishedPackage, exports: ExportsMap | undefined): ApiEntry[] {
  if (!exports) return [];
  return Object.entries(exports).flatMap(([subpath, condition]) => {
    if (typeof condition === "string" || condition.types === undefined) return [];
    return [
      {
        packageName: entry.name,
        subpath,
        declarationFile: path.join(repositoryRoot, entry.location, condition.types),
      },
    ];
  });
}

/** Every published package's entry points, packages in release order. */
export async function apiEntries(): Promise<readonly ApiEntry[]> {
  const packages = await publishedPackages();
  const perPackage = await Promise.all(
    packages.map(async (entry) => {
      const manifest = JSON.parse(
        await readFile(path.join(repositoryRoot, entry.manifest), "utf8"),
      ) as Manifest;
      return entriesOf(entry, manifest.exports);
    }),
  );
  return perPackage.flat();
}

/** Every entry point's names, then every declaration those names reach. */
export function renderApi(entries: readonly ApiEntry[]): string {
  const program = declarationProgram(entries.map((entry) => entry.declarationFile));
  const checker = program.getTypeChecker();
  const collector = new DeclarationCollector(checker);
  const sections = entries.map((entry) => {
    const source = requireSourceFile(program, entry.declarationFile);
    const module = checker.getSymbolAtLocation(source);
    if (!module) throw new Error(`${entry.declarationFile} exports nothing`);
    const lines = checker
      .getExportsOfModule(module)
      .toSorted((left, right) => compare(left.getName(), right.getName()))
      .map((symbol) => collector.exportLine(symbol.getName(), symbol));
    return `### ${entry.packageName} ${entry.subpath}\n\n${lines.join("\n")}\n`;
  });
  collector.closeOver();
  return `## Entry points\n\n${sections.join("\n")}\n## Declarations\n\n${renderBlocks(
    collector.declarations,
  )}\n`;
}
