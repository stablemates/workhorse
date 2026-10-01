import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Acceptance,
  type AdvisoryFinding,
  type AuditProblem,
  collectFindings,
  describeProblems,
  findProblems,
  readAuditReport,
} from "./audit-npm-dependencies.js";

/**
 * Dependency advisory scanning for the build and publication tooling.
 *
 * `pnpm npm:vuln` and `pnpm python:vuln` judge the published closure: what a consumer installs.
 * Build tooling never reaches a consumer, but it executes in CI and in the release jobs, beside the
 * credentials that publish. [ADR 0058](../docs/decisions/0058-fix-the-current-line-and-gate-floors-on-upstream-end-of-life.md)
 * puts that tooling inside the advisory gate, in its own lane, and this file is that lane.
 *
 * The lane reads two trees. The npm half runs `pnpm audit` over the whole workspace, development
 * dependencies included. The Python half runs `pip-audit` over the uv export with every dependency
 * group, plus `python/build-constraints.txt`, which pins the build backend that uv.lock does not
 * cover.
 *
 * The lane judges only what the production gate does not. It also reads each production tree, and
 * an advisory the production gate reports belongs to that gate and its acceptance list. So a
 * tooling acceptance can never let a production finding pass: an entry naming an advisory that the
 * production scan reports fails this lane outright. The production gate still fails on that advisory
 * until its own list answers it.
 */

/** A written decision to let one Python advisory pass in the development or build tooling. */
export interface PythonAcceptance {
  /** Identifier `pip-audit` reports, for example `PYSEC-2024-48` or `GHSA-…`. */
  readonly id: string;
  /** Distribution the advisory names, recorded so a reader does not have to open the advisory. */
  readonly package: string;
  /** Why the advisory does not block a merge or a release. */
  readonly reason: string;
  /** ISO date this entry stops being accepted, after which the lane fails until someone looks. */
  readonly reviewBy: string;
}

/** The tooling acceptance list: one section per ecosystem the lane reads. */
export interface ToolingAcceptances {
  readonly npm: readonly Acceptance[];
  readonly python: readonly PythonAcceptance[];
}

/** One Python advisory reaching one installed distribution. */
export interface PythonFinding {
  readonly id: string;
  /** Other identifiers for the same advisory, such as a CVE or GHSA alias. */
  readonly aliases: readonly string[];
  readonly package: string;
  readonly version: string;
  readonly fixVersions: readonly string[];
}

interface PipAuditVulnerability {
  readonly id?: string;
  readonly aliases?: readonly string[];
  readonly fix_versions?: readonly string[];
}

interface PipAuditDependency {
  readonly name?: string;
  readonly version?: string;
  readonly vulns?: readonly PipAuditVulnerability[];
  readonly skip_reason?: string;
}

/** What `pip-audit --format json` writes. */
export interface PipAuditReport {
  readonly dependencies?: readonly PipAuditDependency[];
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");

/** Where the tooling acceptance list lives, named in every failure so the reader knows what to edit. */
export const toolingAcceptanceFileName = "scripts/tooling-advisory-acceptances.json";

// The build backend every Python build uses. CI and the release builds name it in UV_BUILD_CONSTRAINT.
const buildConstraints = "python/build-constraints.txt";

const heading = "Build and publication tooling advisories need a decision:";

/**
 * Flatten one or more `pip-audit` reports into one entry per advisory and distribution.
 *
 * The development export and the build backend are audited in separate runs, and a distribution
 * both pin at one version appears in each. It is reported once.
 */
export function collectPythonFindings(
  ...reports: readonly PipAuditReport[]
): readonly PythonFinding[] {
  const findings: PythonFinding[] = [];
  const seen = new Set<string>();
  for (const dependency of reports.flatMap((report) => report.dependencies ?? [])) {
    for (const vulnerability of dependency.vulns ?? []) {
      const key = `${dependency.name ?? ""}\0${dependency.version ?? ""}\0${vulnerability.id ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        id: vulnerability.id ?? "unknown",
        aliases: vulnerability.aliases ?? [],
        package: dependency.name ?? "unknown",
        version: dependency.version ?? "unknown",
        fixVersions: vulnerability.fix_versions ?? [],
      });
    }
  }
  return findings.toSorted(
    (left, right) => left.package.localeCompare(right.package) || left.id.localeCompare(right.id),
  );
}

function pythonIdentifiers(finding: PythonFinding): readonly string[] {
  return [finding.id, ...finding.aliases];
}

/**
 * Entries that fail before any advisory is judged: no reason, or a review date that is not a real
 * calendar date. An entry like that would otherwise pass forever or never.
 */
function findMalformedAcceptances(acceptances: ToolingAcceptances): readonly AuditProblem[] {
  const problems: AuditProblem[] = [];
  const entries = [
    ...acceptances.npm.map((entry) => ({ label: `npm advisory ${String(entry.advisory)}`, entry })),
    ...acceptances.python.map((entry) => ({ label: `Python advisory ${entry.id}`, entry })),
  ];
  for (const { label, entry } of entries) {
    const date = new Date(`${entry.reviewBy}T00:00:00Z`);
    const realDate =
      /^\d{4}-\d{2}-\d{2}$/.test(entry.reviewBy) &&
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === entry.reviewBy;
    if (entry.reason.trim() === "" || !realDate) {
      problems.push({
        headline: `Acceptance of ${label} needs a reason and a reviewBy calendar date`,
        detail: [`Write both in ${toolingAcceptanceFileName}.`],
      });
    }
  }
  return problems;
}

function productionClaim(label: string, productionList: string): AuditProblem {
  return {
    headline: `${toolingAcceptanceFileName} accepts ${label}, which the production gate reports`,
    detail: [
      "A tooling acceptance cannot let a production finding pass.",
      `Delete the entry, and fix the advisory or answer it in ${productionList}.`,
    ],
  };
}

/**
 * Judge the npm development tree.
 *
 * `all` is the report over the whole workspace and `production` the report the production gate
 * reads. An advisory present in `production` is left to that gate, whatever path it takes in `all`.
 * What remains is held to the production gate's own rules, under the tooling list.
 */
export function findNpmToolingProblems(
  all: readonly AdvisoryFinding[],
  production: readonly AdvisoryFinding[],
  acceptances: readonly Acceptance[],
  today: string,
): readonly AuditProblem[] {
  const productionAdvisories = new Set(production.map((finding) => finding.advisory));
  const problems: AuditProblem[] = [];
  const toolingAcceptances: Acceptance[] = [];
  for (const acceptance of acceptances) {
    if (productionAdvisories.has(acceptance.advisory)) {
      problems.push(
        productionClaim(
          `npm advisory ${String(acceptance.advisory)}`,
          "scripts/npm-advisory-acceptances.json",
        ),
      );
    } else {
      toolingAcceptances.push(acceptance);
    }
  }
  const toolingFindings = all.filter((finding) => !productionAdvisories.has(finding.advisory));
  problems.push(
    ...findProblems(toolingFindings, toolingAcceptances, today, toolingAcceptanceFileName),
  );
  return problems;
}

/**
 * Judge the Python development and build tooling.
 *
 * The production Python gate accepts nothing, so every advisory it reports already fails
 * `pnpm python:vuln`. This lane leaves those advisories to it and refuses an entry that names one.
 */
export function findPythonToolingProblems(
  all: readonly PythonFinding[],
  production: readonly PythonFinding[],
  acceptances: readonly PythonAcceptance[],
  today: string,
): readonly AuditProblem[] {
  const productionIds = new Set(production.flatMap(pythonIdentifiers));
  const problems: AuditProblem[] = [];
  const matched = new Set<PythonAcceptance>();
  const toolingAcceptances = acceptances.filter((acceptance) => {
    if (!productionIds.has(acceptance.id)) return true;
    problems.push(productionClaim(`Python advisory ${acceptance.id}`, "the dependency itself"));
    return false;
  });
  for (const finding of all) {
    const identifiers = pythonIdentifiers(finding);
    if (identifiers.some((id) => productionIds.has(id))) continue;
    const acceptance = toolingAcceptances.find(
      (entry) => entry.package === finding.package && identifiers.includes(entry.id),
    );
    if (acceptance) {
      matched.add(acceptance);
      continue;
    }
    problems.push({
      headline: `Advisory ${finding.id} in ${finding.package} is not accepted in ${toolingAcceptanceFileName}`,
      detail: [
        `${finding.package}@${finding.version} · ${[finding.id, ...finding.aliases].join(", ")}`,
        `fix:  ${finding.fixVersions.join(", ") || "no fixed version published"}`,
      ],
    });
  }
  for (const acceptance of toolingAcceptances) {
    if (acceptance.reviewBy < today) {
      problems.push({
        headline: `Acceptance of advisory ${acceptance.id} was due for review on ${acceptance.reviewBy}`,
        detail: [
          `${acceptance.package} · reason: ${acceptance.reason}`,
          `Take the fix, or restate the reason and move reviewBy forward in ${toolingAcceptanceFileName}.`,
        ],
      });
    } else if (!matched.has(acceptance)) {
      problems.push({
        headline: `Acceptance of advisory ${acceptance.id} matches nothing pip-audit reports`,
        detail: [
          `${acceptance.package}`,
          `Delete the entry from ${toolingAcceptanceFileName}; the advisory is gone from the tree.`,
        ],
      });
    }
  }
  return problems;
}

/** The four reports the lane compares, already flattened. */
export interface ToolingScan {
  readonly npmAll: readonly AdvisoryFinding[];
  readonly npmProduction: readonly AdvisoryFinding[];
  readonly pythonAll: readonly PythonFinding[];
  readonly pythonProduction: readonly PythonFinding[];
}

/** Every reason the tooling lane fails, given the scan and the acceptance list. */
export function findToolingProblems(
  scan: ToolingScan,
  acceptances: ToolingAcceptances,
  today: string,
): readonly AuditProblem[] {
  const malformed = findMalformedAcceptances(acceptances);
  if (malformed.length > 0) return malformed;
  return [
    ...findNpmToolingProblems(scan.npmAll, scan.npmProduction, acceptances.npm, today),
    ...findPythonToolingProblems(scan.pythonAll, scan.pythonProduction, acceptances.python, today),
  ];
}

interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

async function capture(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}

/**
 * The pip-audit report, or a refusal when it describes a scan that never ran in full.
 *
 * pip-audit exits non-zero both on an advisory and on a service it could not reach. Only a completed
 * scan writes a `dependencies` list, so its absence is the signal, and the refusal names the service
 * rather than any acceptance entry. A dependency pip-audit could not look up carries a `skip_reason`
 * and no `vulns`, which would otherwise read as clean, so one skipped dependency refuses the report.
 */
export function requireReadablePipAuditReport(output: string, diagnostics: string): PipAuditReport {
  let report: PipAuditReport | undefined;
  try {
    report = JSON.parse(output) as PipAuditReport;
  } catch {
    report = undefined;
  }
  if (report && Array.isArray(report.dependencies)) {
    const skipped = report.dependencies.filter(
      (dependency) => dependency.skip_reason !== undefined,
    );
    if (skipped.length === 0) return report;
    const names = skipped
      .map((dependency) => `${dependency.name ?? "unknown"} (${dependency.skip_reason ?? ""})`)
      .join("; ");
    throw new Error(
      `pip-audit skipped dependencies it could not audit: ${names}. Nothing was decided about ` +
        `them, so the lane cannot pass.`,
    );
  }
  const reason = diagnostics.trim() || output.trim() || "no output";
  throw new Error(
    `pip-audit did not complete a scan: ${reason}. No decision was made about any dependency, ` +
      `and no acceptance in ${toolingAcceptanceFileName} is stale. Re-run when the service answers.`,
  );
}

/**
 * Export the uv lockfile to a requirements file and audit it with the pinned pip-audit.
 *
 * `--frozen` reads the committed lockfile without resolving. UV_LOCKED is dropped for the export
 * alone, for the reason `scripts/audit-python-dependencies.sh` gives.
 */
async function auditPython(
  directory: string,
  scope: "production" | "tooling",
): Promise<PipAuditReport> {
  const requirements = path.join(directory, `${scope}.txt`);
  const environment = { ...process.env };
  delete environment.UV_LOCKED;
  const exported = await capture(
    "uv",
    [
      "export",
      "--project",
      "python",
      "--frozen",
      "--all-extras",
      scope === "production" ? "--no-dev" : "--all-groups",
      "--no-emit-project",
      "--quiet",
      "--output-file",
      requirements,
    ],
    environment,
  );
  if (exported.exitCode !== 0) {
    throw new Error(
      `uv export exited with ${String(exported.exitCode)}: ${exported.stderr.trim()}`,
    );
  }
  return runPipAudit(requirements);
}

async function runPipAudit(requirements: string): Promise<PipAuditReport> {
  const audited = await capture("uv", [
    "run",
    "--project",
    "python",
    "pip-audit",
    "--requirement",
    requirements,
    "--no-deps",
    "--disable-pip",
    "--format",
    "json",
    "--progress-spinner",
    "off",
  ]);
  return requireReadablePipAuditReport(audited.stdout, audited.stderr);
}

async function readToolingAcceptances(): Promise<ToolingAcceptances> {
  return JSON.parse(
    await readFile(path.join(repositoryRoot, toolingAcceptanceFileName), "utf8"),
  ) as ToolingAcceptances;
}

// The npm release build installs no Python toolchain and builds nothing with one, so it judges only
// the npm half. Every other caller judges both.
type ToolingLanes = "all" | "npm";

export async function auditToolingDependencies(lanes: ToolingLanes = "all"): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "workhorse-tooling-audit-"));
  let scan: ToolingScan;
  try {
    const npmAll = collectFindings(
      await readAuditReport(repositoryRoot, "all", toolingAcceptanceFileName),
    );
    const npmProduction = collectFindings(
      await readAuditReport(repositoryRoot, "prod", toolingAcceptanceFileName),
    );
    scan =
      lanes === "npm"
        ? { npmAll, npmProduction, pythonAll: [], pythonProduction: [] }
        : {
            npmAll,
            npmProduction,
            // The build backend runs in an isolated environment, so it may pin a distribution the
            // development export also pins at another version. One pip-audit run refuses that.
            pythonAll: collectPythonFindings(
              await auditPython(directory, "tooling"),
              await runPipAudit(buildConstraints),
            ),
            pythonProduction: collectPythonFindings(await auditPython(directory, "production")),
          };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const today = new Date().toISOString().slice(0, 10);
  const acceptances = await readToolingAcceptances();
  const judged = lanes === "npm" ? { npm: acceptances.npm, python: [] } : acceptances;
  const problems = findToolingProblems(scan, judged, today);
  if (problems.length > 0) throw new Error(describeProblems(problems, heading));
  process.stdout.write(
    lanes === "npm"
      ? "pnpm audit over the development tree reports no advisory outside the production gate " +
          "that is not accepted.\n"
      : "pnpm audit over the development tree and pip-audit over the development and build " +
          "tooling report no advisory outside the production gates that is not accepted.\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    await auditToolingDependencies(process.argv.includes("--npm-only") ? "npm" : "all");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
