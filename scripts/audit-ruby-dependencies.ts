import { spawn } from "node:child_process";
import { access, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Dependency advisory scanning for the Ruby gem.
 *
 * `pnpm npm:vuln`, `pnpm python:vuln`, `pnpm go:vuln` and `pnpm rust:vuln` fail their line's build
 * on an advisory the upstream database reports. This is the Ruby equivalent. bundler-audit reads
 * `ruby/Gemfile.lock` and every locked Rails gemfile under `ruby/gemfiles/` against the
 * ruby-advisory-db, and the build fails unless the repository has written down why a reported
 * advisory is acceptable.
 *
 * As in `scripts/audit-npm-dependencies.ts`, a severity threshold is deliberately not the gate:
 * severity describes the advisory, not this repository's exposure to it. Every advisory that
 * reaches a lockfile fails until `scripts/ruby-advisory-acceptances.json` carries a reason and a
 * review date for it. bundler-audit's own `.bundler-audit.yml` ignore list is refused, because it
 * has no review date.
 *
 * bundler-audit reads a local copy of the database and reports a clean tree when that copy is
 * empty or was never refreshed. So the run refreshes the database first and refuses one that has no
 * advisories, is not a git checkout it can refresh, or holds a directory or advisory it cannot read,
 * rather than read silence as a clean tree.
 */

/** One advisory reaching one locked gem version in one lockfile. */
export interface AdvisoryFinding {
  /** Lockfile the gem is locked in, relative to `ruby/`, for example `Gemfile.lock`. */
  readonly lockfile: string;
  /** Advisory identifier as bundler-audit reports it: a CVE, or a GHSA when there is no CVE. */
  readonly advisory: string;
  /** Affected gem, for example `rack`. */
  readonly gem: string;
  /** Locked version of that gem. */
  readonly version: string;
  /** Advisory title. */
  readonly title: string;
  /** Advisory page. */
  readonly url: string;
  /** Version ranges that carry the fix, or an empty list when none is published. */
  readonly patchedVersions: readonly string[];
}

/** A written decision to let one advisory pass for one gem. */
export interface Acceptance {
  /** Advisory identifier this entry covers, as bundler-audit reports it. */
  readonly advisory: string;
  /** Affected gem, recorded so a reader does not have to open the advisory. */
  readonly gem: string;
  /** Why the advisory does not block a release. */
  readonly reason: string;
  /** ISO date this entry stops being accepted, after which the build fails until someone looks. */
  readonly reviewBy: string;
}

/** One entry of the `results` array in `bundle-audit check --format json`. */
export interface AuditResult {
  readonly type?: string;
  readonly source?: string;
  readonly gem?: { readonly name?: string; readonly version?: string };
  readonly advisory?: {
    readonly id?: string;
    readonly url?: string;
    readonly title?: string;
    readonly patched_versions?: readonly string[];
  };
}

/** What `bundle-audit stats` says about the local database. */
export interface DatabaseStats {
  readonly advisories: number;
  readonly commit: string;
  readonly lastUpdated: string;
}

/** One reason the run fails, phrased for a reader who has to act on it. */
export interface AuditProblem {
  readonly headline: string;
  readonly detail: readonly string[];
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const rubyRoot = path.join(repositoryRoot, "ruby");
const acceptanceFile = path.join(repositoryRoot, "scripts", "ruby-advisory-acceptances.json");

/** Where the acceptance list lives, named in every failure so the reader knows what to edit. */
export const acceptanceFileName = "scripts/ruby-advisory-acceptances.json";

/** bundler-audit's own ignore list, which this gate refuses because it carries no review date. */
export const bundlerAuditConfigName = "ruby/.bundler-audit.yml";

interface CommandRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/** Run bundler-audit through the gem's own bundle, so its version is the locked one. */
async function bundleAudit(commandArguments: readonly string[]): Promise<CommandRun> {
  return bundleExec(["bundle-audit", ...commandArguments]);
}

/** Run a command through the gem's own bundle. */
async function bundleExec(commandArguments: readonly string[]): Promise<CommandRun> {
  return new Promise<CommandRun>((resolve, reject) => {
    const child = spawn("bundle", ["exec", ...commandArguments], {
      cwd: rubyRoot,
      env: { ...process.env, BUNDLE_GEMFILE: path.join(rubyRoot, "Gemfile") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT"
          ? new Error(
              "bundle is not on the PATH. Run `mise install`, then run the command through `mise exec -- <command>`.",
            )
          : error,
      ),
    );
    child.once("exit", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}

/** A refusal that says no decision was made, so nobody edits the acceptance list during an outage. */
function unavailable(reason: string): Error {
  return new Error(
    `bundle-audit could not check the Ruby lockfiles against the ruby-advisory-db: ${reason}\n` +
      `No decision was made about any dependency, and no acceptance in ${acceptanceFileName} is ` +
      "stale. Re-run when the database answers.",
  );
}

function quote(run: CommandRun): string {
  return `${run.stdout}\n${run.stderr}`.trim() || "no output";
}

/**
 * The database's size and revision, or a refusal when it cannot vouch for a clean result.
 *
 * bundler-audit reports no advisory for every gem when the database is empty, so a missing or zero
 * count is refused. A database without a commit is not a git checkout, so `bundle-audit update`
 * skips it without an error and it never gains a newer advisory; that is refused as well.
 */
export function parseDatabaseStats(output: string): DatabaseStats {
  const advisories = /^\s*advisories:\s*(\d+) advisories\s*$/m.exec(output)?.[1];
  const commit = /^\s*commit:\s*([0-9a-f]{7,40})\s*$/m.exec(output)?.[1];
  const lastUpdated = /^\s*last updated:\s*(.+?)\s*$/m.exec(output)?.[1] ?? "unknown";
  if (advisories === undefined || Number(advisories) === 0) {
    throw unavailable(`the database holds no advisories (${output.trim() || "no output"})`);
  }
  if (commit === undefined) {
    throw unavailable(
      `the database is not a git checkout, so it cannot be refreshed (${output.trim()})`,
    );
  }
  return { advisories: Number(advisories), commit, lastUpdated };
}

/**
 * The number of advisory files in the database, or a refusal when any part of its tree is unreadable.
 *
 * bundler-audit counts and enumerates advisories with `Dir.glob`, and Ruby's glob silently skips a
 * directory it cannot list. A database whose `gems/pg` is unreadable still reports a positive count
 * from its other gems, and then reports no advisory for pg. So the run reads every directory and
 * opens every advisory under `gems/` and `rubies/` itself, and an access error refuses the run.
 */
export async function readAdvisoryTree(database: string): Promise<number> {
  let advisories = 0;
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw unavailable(`cannot list ${directory}: ${describeError(error)}`);
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.name.endsWith(".yml")) {
        try {
          await (await open(entryPath, "r")).close();
        } catch (error) {
          throw unavailable(`cannot read ${entryPath}: ${describeError(error)}`);
        }
        advisories += 1;
      }
    }
  }
  for (const tree of ["gems", "rubies"]) {
    const root = path.join(database, tree);
    if (tree === "rubies" && !(await exists(root))) continue;
    await walk(root);
  }
  if (advisories === 0) throw unavailable(`${database} holds no advisory files`);
  return advisories;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The acceptance list, or an error naming every entry that cannot be judged.
 *
 * An entry is matched against findings and its review date is compared as text. A missing reason,
 * or a review date that is not a real calendar date such as `never` or `2026-99-99`, would let an
 * advisory pass indefinitely, so such a list is refused before any finding is judged.
 */
export function parseAcceptances(contents: string): readonly Acceptance[] {
  let file: unknown;
  try {
    file = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${acceptanceFileName} is not JSON: ${describeError(error)}`, { cause: error });
  }
  const entries = (file as { acceptances?: unknown } | null)?.acceptances;
  if (!Array.isArray(entries)) {
    throw new TypeError(`${acceptanceFileName} has no acceptances list`);
  }
  const invalid: string[] = [];
  for (const [index, entry] of (entries as unknown[]).entries()) {
    const fields = (entry ?? {}) as Record<string, unknown>;
    const label = `entry ${String(index)}${typeof fields.advisory === "string" ? ` (${fields.advisory})` : ""}`;
    for (const field of ["advisory", "gem", "reason"] as const) {
      const value = fields[field];
      if (typeof value !== "string" || value.trim() === "") {
        invalid.push(`${label} has no ${field}`);
      }
    }
    if (typeof fields.reviewBy !== "string" || !isCalendarDate(fields.reviewBy)) {
      invalid.push(
        `${label} has reviewBy ${JSON.stringify(fields.reviewBy)}, which is not a YYYY-MM-DD date`,
      );
    }
  }
  if (invalid.length > 0) {
    throw new Error(`${acceptanceFileName} cannot be judged:\n  ${invalid.join("\n  ")}`);
  }
  return entries as readonly Acceptance[];
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * The report's results, or a refusal when the run did not produce a report.
 *
 * `bundle-audit check` exits 0 on a clean lockfile and 1 when it reports something, and it writes
 * the JSON report in both cases. Any other exit, or output that is not a report, is a check that
 * did not run.
 */
export function parseAuditReport(
  lockfile: string,
  output: string,
  exitCode: number | null,
): readonly AuditResult[] {
  if (exitCode !== 0 && exitCode !== 1) {
    throw unavailable(`checking ${lockfile} exited with ${String(exitCode)}: ${output.trim()}`);
  }
  let report: unknown;
  try {
    report = JSON.parse(output);
  } catch {
    throw unavailable(`checking ${lockfile} wrote no JSON report: ${output.trim() || "no output"}`);
  }
  const results = (report as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    throw unavailable(`the report for ${lockfile} has no results list: ${output.trim()}`);
  }
  if (exitCode === 1 && results.length === 0) {
    throw unavailable(`checking ${lockfile} exited with 1 but reported nothing`);
  }
  return results as readonly AuditResult[];
}

/**
 * One finding per advisory, gem, and version in a lockfile.
 *
 * bundler-audit repeats a result once per platform variant the lockfile names, so a native gem
 * locked for seven platforms reports one advisory seven times.
 */
export function collectFindings(
  lockfile: string,
  results: readonly AuditResult[],
): readonly AdvisoryFinding[] {
  const findings = new Map<string, AdvisoryFinding>();
  for (const result of results) {
    if (result.type !== "unpatched_gem") continue;
    const finding: AdvisoryFinding = {
      lockfile,
      advisory: result.advisory?.id ?? "unknown",
      gem: result.gem?.name ?? "unknown",
      version: result.gem?.version ?? "unknown",
      title: result.advisory?.title ?? "",
      url: result.advisory?.url ?? "",
      patchedVersions: result.advisory?.patched_versions ?? [],
    };
    findings.set(`${finding.advisory} ${finding.gem} ${finding.version}`, finding);
  }
  return [...findings.values()].toSorted(
    (left, right) =>
      left.gem.localeCompare(right.gem) || left.advisory.localeCompare(right.advisory),
  );
}

/**
 * Results that are not an advisory against a gem, such as a gem source fetched over plain HTTP.
 * The acceptance list cannot answer them, so each fails the run.
 */
export function findUnexplainedResults(
  lockfile: string,
  results: readonly AuditResult[],
): readonly AuditProblem[] {
  return results
    .filter((result) => result.type !== "unpatched_gem")
    .map((result) => ({
      headline: `bundle-audit reported ${result.type ?? "an unknown result"} in ${lockfile}`,
      detail: [result.source ?? JSON.stringify(result)],
    }));
}

/**
 * Compare the findings from every lockfile against the acceptance list.
 *
 * Three things fail, as in the npm scan: an advisory nobody has written about, an acceptance whose
 * review date has passed, and an acceptance that no longer matches anything in any lockfile.
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
      (entry) => entry.advisory === finding.advisory && entry.gem === finding.gem,
    );
    if (acceptance) {
      matched.add(acceptance);
      continue;
    }
    problems.push({
      headline: `Advisory ${finding.advisory} in ${finding.gem} is not accepted in ${acceptanceFileName}`,
      detail: [
        `${finding.gem}@${finding.version} in ruby/${finding.lockfile} · ${finding.title}`,
        `fix:  ${finding.patchedVersions.length > 0 ? `upgrade to ${finding.patchedVersions.join(", ")}` : "no patched version published"}`,
        `see:  ${finding.url}`,
      ],
    });
  }
  for (const acceptance of acceptances) {
    if (acceptance.reviewBy < today) {
      problems.push({
        headline: `Acceptance of advisory ${acceptance.advisory} was due for review on ${acceptance.reviewBy}`,
        detail: [
          `${acceptance.gem} · reason: ${acceptance.reason}`,
          `Take the fix, or restate the reason and move reviewBy forward in ${acceptanceFileName}.`,
        ],
      });
      continue;
    }
    if (!matched.has(acceptance)) {
      problems.push({
        headline: `Acceptance of advisory ${acceptance.advisory} matches nothing bundle-audit reports`,
        detail: [
          acceptance.gem,
          `Delete the entry from ${acceptanceFileName}; the advisory is gone from every lockfile.`,
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
  return `Ruby dependency advisories need a decision:\n\n${lines.join("\n")}`;
}

/** `Gemfile.lock` and every locked Rails gemfile, relative to `ruby/`. */
export async function lockfilesToAudit(): Promise<readonly string[]> {
  const gemfiles = await readdir(path.join(rubyRoot, "gemfiles"));
  return [
    "Gemfile.lock",
    ...gemfiles
      .filter((name) => name.endsWith(".gemfile.lock"))
      .toSorted()
      .map((name) => `gemfiles/${name}`),
  ];
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Where bundler-audit keeps its database when the run names none. */
async function defaultDatabase(): Promise<string> {
  const run = await bundleExec([
    "ruby",
    "-rbundler/audit/database",
    "-e",
    "print Bundler::Audit::Database.path",
  ]);
  if (run.exitCode !== 0 || run.stdout.trim() === "") {
    throw unavailable(`bundler-audit did not name its database path: ${quote(run)}`);
  }
  return run.stdout.trim();
}

/**
 * Audit every Ruby lockfile.
 *
 * `--database <dir>` points the run at a fixed database and skips the refresh, so a verification
 * run can read a seeded copy. Without it, the run refreshes bundler-audit's default database first.
 */
async function auditRubyDependencies(commandArguments: readonly string[]): Promise<void> {
  const databaseIndex = commandArguments.indexOf("--database");
  const database = databaseIndex === -1 ? undefined : commandArguments[databaseIndex + 1];
  if (databaseIndex !== -1 && !database) throw new Error("--database needs a directory");
  if (await exists(path.join(repositoryRoot, bundlerAuditConfigName))) {
    throw new Error(
      `${bundlerAuditConfigName} exists. Its ignore list has no review date; move each entry to ${acceptanceFileName} with a reason and a reviewBy date, then delete the file.`,
    );
  }
  if (database === undefined) {
    const update = await bundleAudit(["update", "--quiet"]);
    if (update.exitCode !== 0) {
      throw unavailable(
        `bundle-audit update exited with ${String(update.exitCode)}: ${quote(update)}`,
      );
    }
  }
  const databaseArguments = database === undefined ? [] : ["--database", path.resolve(database)];
  const statsRun = await bundleAudit([
    "stats",
    ...(database === undefined ? [] : [path.resolve(database)]),
  ]);
  if (statsRun.exitCode !== 0) {
    throw unavailable(
      `bundle-audit stats exited with ${String(statsRun.exitCode)}: ${quote(statsRun)}`,
    );
  }
  const stats = parseDatabaseStats(statsRun.stdout);
  await readAdvisoryTree(database === undefined ? await defaultDatabase() : path.resolve(database));

  const lockfiles = await lockfilesToAudit();
  const findings: AdvisoryFinding[] = [];
  const problems: AuditProblem[] = [];
  for (const lockfile of lockfiles) {
    const run = await bundleAudit([
      "check",
      ...databaseArguments,
      "--format",
      "json",
      "--gemfile-lock",
      lockfile,
    ]);
    const results = parseAuditReport(lockfile, run.stdout || run.stderr, run.exitCode);
    findings.push(...collectFindings(lockfile, results));
    problems.push(...findUnexplainedResults(lockfile, results));
  }
  const acceptances = parseAcceptances(await readFile(acceptanceFile, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  problems.push(...findProblems(findings, acceptances, today));
  if (problems.length > 0) throw new Error(describeProblems(problems));
  const checked = `${lockfiles.map((lockfile) => `ruby/${lockfile}`).join(", ")} against ${String(stats.advisories)} advisories at ruby-advisory-db ${stats.commit.slice(0, 12)}`;
  process.stdout.write(
    findings.length === 0
      ? `bundle-audit reports no advisory for ${checked}.\n`
      : `bundle-audit reports ${String(findings.length)} finding${findings.length === 1 ? "" : "s"} for ${checked}, each accepted in ${acceptanceFileName}.\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    await auditRubyDependencies(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
