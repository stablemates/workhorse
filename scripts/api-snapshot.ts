import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { repositoryRoot } from "./packages.js";

/**
 * Write or verify one committed API snapshot.
 *
 * `api/` holds one committed file per language surface that ADR 0054 governs. Each is generated, so
 * the three checks share this module: `--check` compares and reports, and the default writes. A
 * check that only said "stale" would leave the reader to diff two thousand lines by hand, so a
 * failure quotes the lines that changed under labels that say what a change there means. What a
 * change means differs between the files, which is why the caller supplies the wording.
 */

/** How many changed lines a failure prints before it says how many more there are. */
const reportedLines = 25;

/** What one committed snapshot is and how a reader should read a change to it. */
export interface SnapshotContract {
  /** Path from the repository root, for example `api/typescript.txt`. */
  readonly path: string;
  /** Command that rewrites it, for example `pnpm typescript-api:generate`. */
  readonly generateCommand: string;
  /** One sentence naming which half of a difference is the breaking half. */
  readonly meaning: string;
  /** Heading for a line the committed file has and a fresh reading does not. */
  readonly goneLabel: string;
  /** Heading for a line a fresh reading has and the committed file does not. */
  readonly arrivedLabel: string;
}

/** Lines present in `before` but not in `after`, counting repeats. */
function missing(before: readonly string[], after: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const line of after) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  return before.filter((line) => {
    const count = remaining.get(line) ?? 0;
    if (count === 0) return true;
    remaining.set(line, count - 1);
    return false;
  });
}

function report(label: string, lines: readonly string[]): string {
  if (lines.length === 0) return "";
  const shown = lines.slice(0, reportedLines).map((line) => `  ${line.trim()}`);
  const rest = lines.length > reportedLines ? [`  ... ${lines.length - reportedLines} more`] : [];
  return [`\n${label} (${lines.length}):`, ...shown, ...rest].join("\n");
}

/**
 * Compare against or replace the committed file the contract names.
 *
 * The failure names the generator, so the fix for a legitimate change is one command, and quotes
 * the changed lines, so a reviewer can tell a break from an addition without running anything.
 */
export async function writeOrCheck(
  contract: SnapshotContract,
  contents: string,
  check: boolean,
): Promise<void> {
  const filename = path.join(repositoryRoot, contract.path);
  if (!check) {
    await writeFile(filename, contents);
    return;
  }
  const current = await readFile(filename, "utf8").catch(() => "");
  if (current === contents) return;
  const before = current.split("\n").filter((line) => line.trim() !== "");
  const after = contents.split("\n").filter((line) => line.trim() !== "");
  const gone = missing(before, after);
  const arrived = missing(after, before);
  // Both empty means the same lines came back in a different order or spacing. A generator that
  // lets that happen is the defect, so say which one rather than reporting a difference with
  // nothing in it.
  const difference =
    gone.length === 0 && arrived.length === 0
      ? "\nEvery line is still present, so only their order or spacing moved; that generator owes a stable ordering."
      : report(contract.goneLabel, gone) + report(contract.arrivedLabel, arrived);
  throw new Error(
    `${contract.path} no longer describes this surface; run ${contract.generateCommand}.` +
      ` ${contract.meaning}${difference}`,
  );
}
