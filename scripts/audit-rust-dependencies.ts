import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Dependency advisory scanning for the Rust crate.
 *
 * `pnpm npm:vuln`, `pnpm python:vuln` and `pnpm go:vuln` fail their line's build on an advisory the
 * upstream database reports. This is the Rust equivalent. `cargo deny check advisories` reads the
 * root `Cargo.lock` against the RustSec advisory database, and the build fails unless the
 * repository has written down why a reported advisory is acceptable.
 *
 * As in `scripts/audit-npm-dependencies.ts`, a severity threshold is deliberately not the gate:
 * severity describes the advisory, not this repository's exposure to it. Every RustSec entry that
 * reaches the lockfile fails — a vulnerability, and also an unmaintained or unsound notice — until
 * `scripts/rust-advisory-acceptances.json` carries a reason and a review date for it. cargo-deny's
 * own `ignore` list is not used, because it has no review date.
 *
 * `deny.toml` holds the scan's configuration: every feature of the published crate is in the graph,
 * and the yanked-version check is off, because it asks the crates.io index rather than RustSec.
 */

/** One advisory reaching one crate version in the lockfile. */
export interface AdvisoryFinding {
  /** RustSec identifier, for example `RUSTSEC-2024-0421`. */
  readonly advisory: string;
  /** `vulnerability`, `unmaintained`, `unsound`, or `notice`, as cargo-deny reports it. */
  readonly kind: string;
  /** Affected crate, for example `idna`. */
  readonly crate: string;
  /** Locked version of that crate. */
  readonly version: string;
  /** One path from the workspace to the crate, for example `workhorse>jsonschema>ahash`. */
  readonly dependencyPath: string;
  /** Advisory title. */
  readonly title: string;
  /** RustSec page for the advisory. */
  readonly url: string;
  /** cargo-deny's remedy, for example `Upgrade to >=1.0.0`, or an empty string when it has none. */
  readonly solution: string;
}

/** A written decision to let one advisory pass for one crate. */
export interface Acceptance {
  /** RustSec identifier this entry covers. */
  readonly advisory: string;
  /** Affected crate, recorded so a reader does not have to open the advisory. */
  readonly crate: string;
  /** Why the advisory does not block a release. */
  readonly reason: string;
  /** ISO date this entry stops being accepted, after which the build fails until someone looks. */
  readonly reviewBy: string;
}

interface AcceptanceFile {
  readonly acceptances: readonly Acceptance[];
}

interface DependencyGraph {
  readonly Krate?: { readonly name?: string; readonly version?: string };
  readonly parents?: readonly DependencyGraph[];
}

/** One line of `cargo deny --format json` output. */
export interface DenyRecord {
  readonly type?: string;
  readonly fields?: {
    readonly code?: string;
    readonly message?: string;
    readonly level?: string;
    readonly severity?: string;
    readonly notes?: readonly string[];
    readonly graphs?: readonly DependencyGraph[];
    readonly advisory?: {
      readonly id?: string;
      readonly package?: string;
      readonly title?: string;
    };
  };
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const acceptanceFile = path.join(repositoryRoot, "scripts", "rust-advisory-acceptances.json");

/** Where the acceptance list lives, named in every failure so the reader knows what to edit. */
export const acceptanceFileName = "scripts/rust-advisory-acceptances.json";

interface DenyRun {
  readonly output: string;
  readonly exitCode: number | null;
}

/**
 * Run the advisories check and return its records, or refuse a run that never read the database.
 *
 * `extraArguments` go before `check`, so a verification run can point `--config` at a seeded
 * database and pass `--offline`. `--locked` stays in every run: the committed lockfile is the set an
 * audit is about, and a stale one should fail rather than be resolved again.
 */
export async function readDenyReport(
  extraArguments: readonly string[] = [],
): Promise<readonly DenyRecord[]> {
  const commandArguments = [
    "--format",
    "json",
    "--color",
    "never",
    "--locked",
    ...extraArguments,
    "check",
    "advisories",
  ];
  const run = await new Promise<DenyRun>((resolve, reject) => {
    const child = spawn("cargo-deny", commandArguments, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT"
          ? new Error(
              "cargo-deny is not on the PATH. Run `mise install`, then run the command through `mise exec -- <command>`.",
            )
          : error,
      ),
    );
    child.once("exit", (exitCode) => resolve({ output, exitCode }));
  });
  return requireReadableReport(parseDenyOutput(run.output), run.output, run.exitCode);
}

/** Parse cargo-deny's line-delimited JSON, keeping any line that is not JSON as plain text. */
export function parseDenyOutput(output: string): readonly DenyRecord[] {
  const records: DenyRecord[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as DenyRecord);
    } catch {
      records.push({ type: "text", fields: { message: line } });
    }
  }
  return records;
}

/**
 * The records, or a refusal when they describe a check that never ran.
 *
 * cargo-deny exits non-zero both when it reports an advisory and when it could not fetch the
 * advisory database, so the exit code cannot tell the two apart. The `summary` record does: a
 * check that read the database ends with one, even when the tree is clean, and a failed fetch or a
 * broken configuration stops before writing it. So a missing summary is refused rather than read as
 * a clean tree, and the refusal names the database instead of {@link acceptanceFileName}, because
 * nothing is known about the acceptance list when the check did not run.
 */
export function requireReadableReport(
  records: readonly DenyRecord[],
  output = "",
  exitCode: number | null = null,
): readonly DenyRecord[] {
  if (records.some((record) => record.type === "summary")) return records;
  const errors = records
    .filter(
      (record) =>
        record.fields?.level === "ERROR" || record.type === "diagnostic" || record.type === "text",
    )
    .map((record) => record.fields?.message?.trim() ?? "")
    .filter((message) => message !== "");
  const reason = errors.join("; ") || output.trim() || "no output";
  throw new Error(
    `cargo deny check advisories exited with ${String(exitCode)} without checking Cargo.lock ` +
      `against the RustSec advisory database: ${reason}\nNo decision was made about any dependency, and no acceptance ` +
      `in ${acceptanceFileName} is stale. Re-run when the database answers.`,
  );
}

/** The first path from the workspace down to a crate, written root first. */
function firstPath(graph: DependencyGraph | undefined): string {
  const names: string[] = [];
  let node = graph;
  while (node?.Krate) {
    names.push(node.Krate.name ?? "unknown");
    node = node.parents?.[0];
  }
  return names.toReversed().join(">");
}

/** One finding per advisory diagnostic. */
export function collectFindings(records: readonly DenyRecord[]): readonly AdvisoryFinding[] {
  const findings: AdvisoryFinding[] = [];
  for (const record of records) {
    const fields = record.fields;
    const advisory = fields?.advisory;
    if (record.type !== "diagnostic" || !advisory) continue;
    const id = advisory.id ?? "unknown";
    const graph = fields.graphs?.[0];
    const solution = fields.notes?.find((note) => note.startsWith("Solution: ")) ?? "";
    findings.push({
      advisory: id,
      kind: fields.code ?? "unknown",
      crate: graph?.Krate?.name ?? advisory.package ?? "unknown",
      version: graph?.Krate?.version ?? "unknown",
      dependencyPath: firstPath(graph),
      title: advisory.title ?? fields.message ?? "",
      url: `https://rustsec.org/advisories/${id}`,
      solution: solution.slice("Solution: ".length),
    });
  }
  return findings.toSorted(
    (left, right) =>
      left.crate.localeCompare(right.crate) || left.advisory.localeCompare(right.advisory),
  );
}

/** One reason the run fails, phrased for a reader who has to act on it. */
export interface AuditProblem {
  readonly headline: string;
  readonly detail: readonly string[];
}

/**
 * Errors cargo-deny reported about something other than an advisory, such as a source it could not
 * match. The acceptance list cannot answer them, so each fails the run with cargo-deny's own words.
 */
export function findUnexplainedErrors(records: readonly DenyRecord[]): readonly AuditProblem[] {
  return records
    .filter(
      (record) =>
        record.type === "diagnostic" &&
        !record.fields?.advisory &&
        record.fields?.severity === "error",
    )
    .map((record) => ({
      headline: `cargo deny reported ${record.fields?.code ?? "an error"}: ${record.fields?.message ?? ""}`,
      detail: record.fields?.notes ?? [],
    }));
}

/**
 * Compare the findings against the acceptance list.
 *
 * Three things fail, as in the npm scan: an advisory nobody has written about, an acceptance whose
 * review date has passed, and an acceptance that no longer matches anything.
 */
export function findProblems(
  findings: readonly AdvisoryFinding[],
  acceptances: readonly Acceptance[],
  today: string,
): readonly AuditProblem[] {
  const problems: AuditProblem[] = [];
  const matched = new Set<Acceptance>();
  for (const finding of findings) {
    const acceptance = acceptances.find(
      (entry) => entry.advisory === finding.advisory && entry.crate === finding.crate,
    );
    if (acceptance) {
      matched.add(acceptance);
      continue;
    }
    problems.push({
      headline: `Advisory ${finding.advisory} in ${finding.crate} is not accepted in ${acceptanceFileName}`,
      detail: [
        `${finding.kind} · ${finding.crate}@${finding.version} · ${finding.title}`,
        `path: ${finding.dependencyPath}`,
        `fix:  ${finding.solution || "no remedy published"}`,
        `see:  ${finding.url}`,
      ],
    });
  }
  for (const acceptance of acceptances) {
    if (acceptance.reviewBy < today) {
      problems.push({
        headline: `Acceptance of advisory ${acceptance.advisory} was due for review on ${acceptance.reviewBy}`,
        detail: [
          `${acceptance.crate} · reason: ${acceptance.reason}`,
          `Take the fix, or restate the reason and move reviewBy forward in ${acceptanceFileName}.`,
        ],
      });
      continue;
    }
    if (!matched.has(acceptance)) {
      problems.push({
        headline: `Acceptance of advisory ${acceptance.advisory} matches nothing cargo deny reports`,
        detail: [
          acceptance.crate,
          `Delete the entry from ${acceptanceFileName}; the advisory is gone from the lockfile.`,
        ],
      });
    }
  }
  return problems;
}

/** Assemble one message from every problem. */
export function describeProblems(problems: readonly AuditProblem[]): string {
  const lines: string[] = [];
  for (const problem of problems) {
    lines.push(problem.headline);
    for (const line of problem.detail) lines.push(`  ${line}`);
    lines.push("");
  }
  return `Rust dependency advisories need a decision:\n\n${lines.join("\n")}`;
}

async function auditRustDependencies(extraArguments: readonly string[]): Promise<void> {
  const records = await readDenyReport(extraArguments);
  const findings = collectFindings(records);
  const file = JSON.parse(await readFile(acceptanceFile, "utf8")) as AcceptanceFile;
  const today = new Date().toISOString().slice(0, 10);
  const problems = [
    ...findUnexplainedErrors(records),
    ...findProblems(findings, file.acceptances, today),
  ];
  if (problems.length > 0) throw new Error(describeProblems(problems));
  const accepted = findings.length;
  process.stdout.write(
    accepted === 0
      ? "cargo deny check advisories reports no RustSec advisory for Cargo.lock.\n"
      : `cargo deny check advisories reports ${String(accepted)} RustSec finding${accepted === 1 ? "" : "s"}, each accepted in ${acceptanceFileName}.\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    await auditRustDependencies(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
