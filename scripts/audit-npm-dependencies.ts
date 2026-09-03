import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

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

interface AuditReport {
  readonly advisories?: Readonly<Record<string, AuditAdvisory>>;
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const acceptanceFile = path.join(repositoryRoot, "scripts", "npm-advisory-acceptances.json");

/** Where the acceptance list lives, named in every failure so the reader knows what to edit. */
export const acceptanceFileName = "scripts/npm-advisory-acceptances.json";

/**
 * `pnpm audit` exits non-zero when it reports an advisory, so the exit code cannot separate
 * "found advisories" from "could not run". The report on stdout does, and an unparseable stdout is
 * the only real failure.
 */
interface AuditRun {
  readonly report: string;
  readonly diagnostics: string;
  readonly exitCode: number | null;
}

async function runAudit(): Promise<AuditReport> {
  const run = await new Promise<AuditRun>((resolve, reject) => {
    const child = spawn("pnpm", ["audit", "--prod", "--json"], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let report = "";
    let diagnostics = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (report += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (diagnostics += chunk));
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve({ report, diagnostics, exitCode }));
  });
  try {
    return JSON.parse(run.report) as AuditReport;
  } catch {
    const detail = run.diagnostics.trim() || run.report.trim() || "no output";
    throw new Error(
      `pnpm audit --prod --json exited with ${String(run.exitCode)} and no report: ${detail}`,
    );
  }
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

export async function auditNpmDependencies(): Promise<void> {
  const findings = collectFindings(await runAudit());
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
  const lines: string[] = [];
  for (const problem of problems) {
    lines.push(problem.headline);
    for (const line of problem.detail) lines.push(`  ${line}`);
    lines.push("");
  }
  throw new Error(`npm dependency advisories need a decision:\n\n${lines.join("\n")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    await auditNpmDependencies();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
