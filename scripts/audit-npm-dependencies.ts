import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { publishedPackages } from "./packages.js";

/**
 * Dependency advisory scanning for the npm half of the repository.
 *
 * `pnpm python:vuln` and `pnpm go:vuln` fail their line's build on any advisory the upstream
 * database reports. This is the npm equivalent, and it holds the same standing: `pnpm audit --prod`
 * reports an advisory, and the build fails unless the repository has written down why that advisory
 * is acceptable.
 *
 * A severity threshold is deliberately not the gate. Severity describes the advisory, not this
 * repository's exposure to it, so a threshold both hides advisories that matter here and fails on
 * ones that cannot. Every reported advisory instead needs an entry in
 * `scripts/npm-advisory-acceptances.json` carrying a reason and a review date, which is what
 * [ADR 0058](../docs/decisions/0058-fix-the-current-line-and-gate-floors-on-upstream-end-of-life.md)
 * and `SECURITY.md` ask a reader to be able to find.
 *
 * An acceptance names the workspace packages it covers rather than the whole dependency path. The
 * path below the workspace package churns on every transitive bump; the workspace package is what
 * decides whether the advisory is inside the published closure. So `js-yaml` reached through `site`
 * stays accepted when `site` reorganises its tree, and the same advisory reaching
 * `typescript__core` fails the build.
 */

/** One advisory finding, flattened to the single dependency path that reached it. */
export interface AdvisoryFinding {
  /** Advisory identifier `pnpm audit` reports, for example `1139427`. */
  readonly advisory: number;
  /** GitHub advisory identifier, for example `GHSA-2v37-7h3g-55p8`. */
  readonly githubAdvisoryId: string;
  /** `low`, `moderate`, `high`, or `critical`. */
  readonly severity: string;
  /** Vulnerable package, for example `nanoid`. */
  readonly module: string;
  /** Installed version of that package. */
  readonly version: string;
  /** Dependency path, for example `site>@tanstack/react-start>vite>postcss>nanoid`. */
  readonly dependencyPath: string;
  /**
   * First segment of the dependency path: the workspace package that pulls the advisory in.
   * `pnpm audit` writes a workspace name with `/` replaced by `__`, so `typescript/core` appears
   * as `typescript__core`.
   */
  readonly workspacePackage: string;
  /** Advisory title. */
  readonly title: string;
  /** Advisory page. */
  readonly url: string;
  /** Versions the advisory is fixed in, or an empty string when there is no fix. */
  readonly patchedVersions: string;
}

/** A written decision to let one advisory pass, reached through the workspace packages it names. */
export interface Acceptance {
  /** Advisory identifier this entry covers. */
  readonly advisory: number;
  /** GitHub advisory identifier, so a reader can find the entry from an advisory page. */
  readonly githubAdvisoryId: string;
  /** Vulnerable package, recorded so a reader does not have to open the advisory. */
  readonly module: string;
  /**
   * Workspace packages this entry covers, named the way `pnpm audit` writes them. The advisory
   * reaching any other workspace package fails the build.
   */
  readonly workspacePackages: readonly string[];
  /** Why the advisory does not block a release. */
  readonly reason: string;
  /** ISO date this entry stops being accepted, after which the build fails until someone looks. */
  readonly reviewBy: string;
}

interface AcceptanceFile {
  readonly acceptances: readonly Acceptance[];
}

interface AuditFinding {
  readonly version?: string;
  readonly paths?: readonly string[];
}

interface AuditAdvisory {
  readonly id?: number;
  readonly severity?: string;
  readonly module_name?: string;
  readonly title?: string;
  readonly url?: string;
  readonly github_advisory_id?: string;
  readonly patched_versions?: string;
  readonly findings?: readonly AuditFinding[];
}

export interface AuditReport {
  readonly advisories?: Readonly<Record<string, AuditAdvisory>>;
  /**
   * What `pnpm audit` writes instead of a tree when it could not reach the advisory service, for
   * example `{"code":"ERR_SOCKET_TIMEOUT","message":"request to …/security/audits failed"}`.
   */
  readonly error?: { readonly code?: string; readonly message?: string };
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const acceptanceFile = path.join(repositoryRoot, "scripts", "npm-advisory-acceptances.json");

/** Where the acceptance list lives, named in every failure so the reader knows what to edit. */
export const acceptanceFileName = "scripts/npm-advisory-acceptances.json";

/**
 * `pnpm audit` exits non-zero when it reports an advisory, so the exit code cannot separate
 * "found advisories" from "could not run". The report on stdout does, and it fails in two ways: it
 * can be unparseable, and it can parse into an `error` object naming a request that never
 * completed.
 *
 * The second is the one that matters. An error report carries no `advisories` key, so reading it as
 * a tree flattens to zero findings — a clean bill of health for a query that never ran. With
 * acceptances on file that surfaces as four instructions to delete a reviewed decision; with none,
 * it passes a real advisory straight through the gate ADR 0043 built to stop it. So an unusable
 * report is refused rather than interpreted, and the refusal names the service instead of the
 * acceptance file.
 */
interface AuditRun {
  readonly report: string;
  readonly diagnostics: string;
  readonly exitCode: number | null;
}

/**
 * Run `pnpm audit --prod --json` in one directory and return a report worth reading.
 *
 * The directory is a parameter because two gates audit two different trees. `pnpm npm:vuln` audits
 * the workspace the lockfile pins; the packed-release gate audits a throwaway consumer that has the
 * published tarballs installed. Both meet the same service and both can be handed the same
 * unusable answer, so both come through here.
 */
export async function readAuditReport(directory: string = repositoryRoot): Promise<AuditReport> {
  const run = await new Promise<AuditRun>((resolve, reject) => {
    const child = spawn("pnpm", ["audit", "--prod", "--json"], {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let report = "";
    let diagnostics = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (report += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (diagnostics += chunk));
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve({ report, diagnostics, exitCode }));
  });
  let parsed: AuditReport;
  try {
    parsed = JSON.parse(run.report) as AuditReport;
  } catch {
    const detail = run.diagnostics.trim() || run.report.trim() || "no output";
    throw new Error(
      `pnpm audit --prod --json exited with ${String(run.exitCode)} and no report: ${detail}`,
    );
  }
  return requireReadableReport(parsed, run.diagnostics);
}

/**
 * The report, or a refusal when it describes a query that never ran.
 *
 * `advisories` is `{}` for a genuinely clean tree and absent when no tree was read at all, so the
 * missing key is the signal rather than an empty one. The message names the service rather than
 * {@link acceptanceFileName}, because nothing about the acceptance list is known when the audit did
 * not answer, and the failure this replaces told the reader to delete four reviewed decisions.
 */
export function requireReadableReport(report: AuditReport, diagnostics = ""): AuditReport {
  if (!report.error && report.advisories !== undefined) return report;
  const reason =
    report.error?.message || diagnostics.trim() || "the report carried no advisories and no error";
  const code = report.error?.code;
  throw new Error(
    `pnpm audit --prod --json could not read the npm advisory service: ${reason}` +
      `${code ? ` (${code})` : ""}. No decision was made about any dependency, and no acceptance ` +
      `in ${acceptanceFileName} is stale. Re-run when the service answers.`,
  );
}

/** Flatten the report's advisory-keyed findings into one entry per dependency path. */
export function collectFindings(report: AuditReport): readonly AdvisoryFinding[] {
  const findings: AdvisoryFinding[] = [];
  for (const advisory of Object.values(report.advisories ?? {})) {
    for (const finding of advisory.findings ?? []) {
      for (const dependencyPath of finding.paths ?? []) {
        findings.push({
          advisory: advisory.id ?? 0,
          githubAdvisoryId: advisory.github_advisory_id ?? "",
          severity: advisory.severity ?? "unknown",
          module: advisory.module_name ?? "unknown",
          version: finding.version ?? "unknown",
          dependencyPath,
          workspacePackage: dependencyPath.split(">")[0] ?? dependencyPath,
          title: advisory.title ?? "",
          url: advisory.url ?? "",
          patchedVersions: advisory.patched_versions ?? "",
        });
      }
    }
  }
  return findings.toSorted(
    (left, right) =>
      left.dependencyPath.localeCompare(right.dependencyPath) || left.advisory - right.advisory,
  );
}

/** One reason the run fails, phrased for a reader who has to act on it. */
export interface AuditProblem {
  readonly headline: string;
  readonly detail: readonly string[];
}

function describeFinding(finding: AdvisoryFinding): readonly string[] {
  return [
    `${finding.severity} · ${finding.module}@${finding.version} · advisory ${String(finding.advisory)}`,
    `path: ${finding.dependencyPath}`,
    `fix:  ${finding.patchedVersions || "no patched version published"}`,
    `see:  ${finding.url}`,
  ];
}

/**
 * Compare the audit against the acceptance list.
 *
 * Three things fail, and each is a question someone has to answer:
 * an advisory nobody has written about, an acceptance whose review date has passed, and an
 * acceptance that no longer matches anything.
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
      (entry) =>
        entry.advisory === finding.advisory &&
        entry.workspacePackages.includes(finding.workspacePackage),
    );
    if (acceptance) {
      matched.add(acceptance);
      continue;
    }
    const elsewhere = acceptances.find((entry) => entry.advisory === finding.advisory);
    if (elsewhere) matched.add(elsewhere);
    problems.push({
      headline: elsewhere
        ? `Advisory ${String(finding.advisory)} now reaches ${finding.workspacePackage}, which ${acceptanceFileName} does not accept`
        : `Advisory ${String(finding.advisory)} in ${finding.module} is not accepted in ${acceptanceFileName}`,
      detail: describeFinding(finding),
    });
  }
  for (const acceptance of acceptances) {
    if (acceptance.reviewBy < today) {
      problems.push({
        headline: `Acceptance of advisory ${String(acceptance.advisory)} was due for review on ${acceptance.reviewBy}`,
        detail: [
          `${acceptance.module} · ${acceptance.githubAdvisoryId}`,
          `reason: ${acceptance.reason}`,
          `Take the fix, or restate the reason and move reviewBy forward in ${acceptanceFileName}.`,
        ],
      });
      continue;
    }
    if (!matched.has(acceptance)) {
      problems.push({
        headline: `Acceptance of advisory ${String(acceptance.advisory)} matches nothing pnpm audit reports`,
        detail: [
          `${acceptance.module} · ${acceptance.githubAdvisoryId}`,
          `Delete the entry from ${acceptanceFileName}; the advisory is gone from the tree.`,
        ],
      });
    }
  }
  return problems;
}

async function readAcceptances(): Promise<readonly Acceptance[]> {
  const file = JSON.parse(await readFile(acceptanceFile, "utf8")) as AcceptanceFile;
  return file.acceptances;
}

/** Assemble one message from every problem, so both gates report a finding in the same shape. */
export function describeProblems(problems: readonly AuditProblem[]): string {
  const lines: string[] = [];
  for (const problem of problems) {
    lines.push(problem.headline);
    for (const line of problem.detail) lines.push(`  ${line}`);
    lines.push("");
  }
  return `npm dependency advisories need a decision:\n\n${lines.join("\n")}`;
}

export async function auditNpmDependencies(): Promise<void> {
  const findings = collectFindings(await readAuditReport());
  const acceptances = await readAcceptances();
  const today = new Date().toISOString().slice(0, 10);
  const problems = findProblems(findings, acceptances, today);
  if (problems.length === 0) {
    const accepted = findings.length;
    process.stdout.write(
      accepted === 0
        ? "pnpm audit --prod reports no advisory.\n"
        : `pnpm audit --prod reports ${String(accepted)} advisory finding${accepted === 1 ? "" : "s"}, each accepted in ${acceptanceFileName}.\n`,
    );
    return;
  }
  throw new Error(describeProblems(problems));
}

/**
 * Severities the packed-release gate refuses.
 *
 * {@link findProblems} applies no threshold, for the reason stated at the top of this file, and it
 * reads the tree the lockfile pins. The packed gate reads a different tree: the published tarballs
 * installed from a fresh resolution, which is what someone installing the release receives. It asks
 * the narrower question a release has to answer — does the tree a user gets carry something severe —
 * and leaves "is every advisory written down" to `pnpm npm:vuln`, which covers the same packages.
 */
const packedSeverities = new Set(["high", "critical"]);

/** `pnpm audit` writes `typescript/core` as `typescript__core`, so a location converts to a name. */
function auditWorkspaceName(location: string): string {
  return location.replace(/\//g, "__");
}

/**
 * Compare the packed release tree against the acceptance list.
 *
 * Nothing in that tree is a workspace package — outside a workspace `pnpm audit` roots every
 * dependency path at `.`, the throwaway consumer the tarballs were installed into — so an
 * acceptance cannot be matched by the package a finding reaches. It is matched by its own claim
 * instead. An entry naming only `site` says the advisory is outside the published closure, and an
 * advisory reported here is inside it, so that entry does not cover this finding. Only an entry
 * naming a published package does.
 *
 * The stale and unmatched checks {@link findProblems} makes stay with `pnpm npm:vuln`. Every entry
 * written about a package outside the published closure matches nothing here by design, and a
 * release is the wrong moment to ask a maintainer to re-date a decision about `site`.
 */
export function findPublishedClosureProblems(
  findings: readonly AdvisoryFinding[],
  acceptances: readonly Acceptance[],
  publishedWorkspacePackages: readonly string[],
): readonly AuditProblem[] {
  const closure = new Set(publishedWorkspacePackages);
  const problems: AuditProblem[] = [];
  for (const finding of findings) {
    if (!packedSeverities.has(finding.severity)) continue;
    const accepted = acceptances.some(
      (entry) =>
        entry.advisory === finding.advisory &&
        entry.workspacePackages.some((name) => closure.has(name)),
    );
    if (accepted) continue;
    problems.push({
      headline: `Advisory ${String(finding.advisory)} in ${finding.module} reaches the packed release tree, and no entry in ${acceptanceFileName} accepts it for a published package`,
      detail: describeFinding(finding),
    });
  }
  return problems;
}

/**
 * Audit a directory that has the packed tarballs installed.
 *
 * `typescript/core/test/packed-packages.ts` calls this rather than running `pnpm audit` itself, so
 * one implementation decides what an unusable report means. An unreachable advisory service fails
 * with {@link requireReadableReport}'s message, which names the service; an advisory fails with a
 * message naming the advisory and {@link acceptanceFileName}. Telling those two apart is the point,
 * because one says stop and fix the tree and the other says wait and re-run.
 */
export async function auditPackedTree(directory: string): Promise<void> {
  const findings = collectFindings(await readAuditReport(directory));
  const published = await publishedPackages();
  const problems = findPublishedClosureProblems(
    findings,
    await readAcceptances(),
    published.map((entry) => auditWorkspaceName(entry.location)),
  );
  if (problems.length > 0) throw new Error(describeProblems(problems));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    await auditNpmDependencies();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
