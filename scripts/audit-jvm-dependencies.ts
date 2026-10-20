import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  jvmTrainVersion,
  publishedArtifacts,
  withoutPublicationSecrets,
} from "./check-jvm-release.js";

/**
 * Dependency advisory scanning for the three JVM artifacts of ADR 0103.
 *
 * `pnpm npm:vuln`, `pnpm python:vuln`, `pnpm go:vuln`, `pnpm rust:vuln` and `pnpm ruby:vuln` fail
 * their line's build on an advisory the upstream database reports. This is the JVM equivalent. It
 * reads the runtime class paths that a caller resolves from Maven Central, asks the OSV database
 * (https://osv.dev) about every module on them, and the build fails unless the repository has
 * written down why a reported advisory is acceptable.
 *
 * The JVM build has no lockfile. `jvm/gradle/verification-metadata.xml` holds the sha256 checksum of
 * each artifact that the JVM build resolves, and Gradle refuses an artifact that differs from it
 * (`scripts/jvm-verification-metadata.ts`). That file does not decide what a caller resolves: the
 * caller's own conflict resolution selects the versions from the POM and the Gradle module
 * metadata of each artifact. The consumer build of this scan has no verification metadata, so it
 * resolves as a caller does. The scan therefore reads what the artifacts publish. The run publishes
 * `workhorse`, `workhorse-kotlin` and `workhorse-spring-boot-starter` to a scratch Maven repository
 * through `scripts/jvm-dependency-scan/publish.init.gradle.kts`, without a change to the JVM build.
 * The consumer build in `scripts/jvm-dependency-scan/` then resolves each artifact for Java 21 with
 * no feature, with each optional feature that its Gradle module metadata declares, and with every
 * feature together. A feature can change the version that conflict resolution selects, so each set
 * is resolved separately, and the scan reads the union.
 *
 * As in `scripts/audit-npm-dependencies.ts`, a severity threshold is deliberately not the gate:
 * severity describes the advisory, not this repository's exposure to it. Every advisory that
 * reaches a class path fails until `scripts/jvm-advisory-acceptances.json` carries a reason and a
 * review date for it.
 *
 * The OSV API answers an unknown module with no advisory, so silence cannot tell a clean class path
 * from a database that does not know Maven. Each query batch therefore also asks about a canary
 * module with a known advisory, and the run refuses a batch that does not report it.
 */

/** One module on a resolved class path. */
export interface ResolvedModule {
  readonly group: string;
  readonly name: string;
  readonly version: string;
}

/** The runtime class path of one artifact with one set of optional features. */
export interface ResolvedClassPath {
  /** Published artifact, for example `workhorse-spring-boot-starter`. */
  readonly artifact: string;
  /** Optional features the caller asks for, for example `["jackson"]`. Empty for none. */
  readonly features: readonly string[];
  /** Every module outside `run.workhorse` on the class path. */
  readonly modules: readonly ResolvedModule[];
}

/** One entry of the consumer build's plan. */
export interface PlanEntry {
  readonly artifact: string;
  readonly version: string;
  readonly features: readonly string[];
}

/** One advisory reaching one module version. */
export interface AdvisoryFinding {
  /** OSV identifier, for example `GHSA-98qh-xjc8-98pq`. */
  readonly advisory: string;
  /** Affected module as `group:name`, for example `org.postgresql:postgresql`. */
  readonly module: string;
  /** Resolved version of that module. */
  readonly version: string;
  /** The class paths that reach it, for example `workhorse-spring-boot-starter[jackson]`. */
  readonly reachedBy: readonly string[];
  /** Advisory summary. */
  readonly title: string;
  /** Advisory page. */
  readonly url: string;
  /** Versions that carry the fix for this module, or an empty list when none is published. */
  readonly fixedVersions: readonly string[];
}

/** A written decision to let one advisory pass for one module. */
export interface Acceptance {
  /** OSV identifier this entry covers. */
  readonly advisory: string;
  /** Affected module as `group:name`, recorded so a reader does not have to open the advisory. */
  readonly module: string;
  /** Why the advisory does not block a release. */
  readonly reason: string;
  /** ISO date this entry stops being accepted, after which the build fails until someone looks. */
  readonly reviewBy: string;
}

/** The parts of an OSV advisory record that the scan reads. */
export interface AdvisoryRecord {
  readonly id: string;
  readonly summary: string;
  readonly withdrawn: boolean;
  /** Fixed versions for each affected Maven module, keyed by `group:name`. */
  readonly fixedVersions: ReadonlyMap<string, readonly string[]>;
}

/** One reason the run fails, phrased for a reader who has to act on it. */
export interface AuditProblem {
  readonly headline: string;
  readonly detail: readonly string[];
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const jvmDirectory = path.join(repositoryRoot, "jvm");
const scanDirectory = path.join(repositoryRoot, "scripts", "jvm-dependency-scan");
const acceptanceFile = path.join(repositoryRoot, "scripts", "jvm-advisory-acceptances.json");

/** Where the acceptance list lives, named in every failure so the reader knows what to edit. */
export const acceptanceFileName = "scripts/jvm-advisory-acceptances.json";

const osvApi = "https://api.osv.dev/v1";
const requestTimeoutMs = 60_000;

/**
 * A module with an advisory that OSV cannot lose: Log4Shell in log4j-core 2.14.1. Each query batch
 * asks about it, and a batch that does not report the advisory is refused.
 */
export const canary = {
  module: { group: "org.apache.logging.log4j", name: "log4j-core", version: "2.14.1" },
  advisory: "GHSA-jfh8-c2jp-5v3q",
} as const;

/** A refusal that says no decision was made, so nobody edits the acceptance list during an outage. */
function unavailable(reason: string): Error {
  return new Error(
    `The OSV database could not check the JVM class paths: ${reason}\n` +
      `No decision was made about any dependency, and no acceptance in ${acceptanceFileName} is ` +
      "stale. Re-run when the database answers.",
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `group:name` of a module. */
export function moduleKey(module: ResolvedModule): string {
  return `${module.group}:${module.name}`;
}

/** A class path label for a finding, for example `workhorse-spring-boot-starter[jackson,health]`. */
export function classPathLabel(
  classPath: Pick<ResolvedClassPath, "artifact" | "features">,
): string {
  return `${classPath.artifact}[${classPath.features.join(",")}]`;
}

/**
 * The optional features an artifact publishes, read from its Gradle module metadata.
 *
 * Gradle gives a feature `<feature>` of `run.workhorse:<artifact>` the capability
 * `run.workhorse:<artifact>-<feature>`. Reading the features from the published file means that a
 * new feature is scanned without a change here.
 */
export function publishedFeatures(artifact: string, moduleMetadata: string): readonly string[] {
  const metadata = JSON.parse(moduleMetadata) as {
    variants?: readonly { capabilities?: readonly { group?: string; name?: string }[] }[];
  };
  if (!Array.isArray(metadata.variants) || metadata.variants.length === 0) {
    throw new Error(`The Gradle module metadata of ${artifact} has no variants`);
  }
  const features = new Set<string>();
  for (const variant of metadata.variants) {
    for (const capability of variant.capabilities ?? []) {
      const prefix = `${artifact}-`;
      if (capability.group === "run.workhorse" && capability.name?.startsWith(prefix)) {
        features.add(capability.name.slice(prefix.length));
      }
    }
  }
  return [...features].toSorted();
}

/** For each artifact: no feature, each feature alone, and every feature together. */
export function scanPlan(
  version: string,
  features: ReadonlyMap<string, readonly string[]>,
): readonly PlanEntry[] {
  const plan: PlanEntry[] = [];
  for (const [artifact, artifactFeatures] of features) {
    plan.push({ artifact, version, features: [] });
    for (const feature of artifactFeatures) plan.push({ artifact, version, features: [feature] });
    if (artifactFeatures.length > 1) plan.push({ artifact, version, features: artifactFeatures });
  }
  return plan;
}

/**
 * The class paths the consumer build resolved, or a refusal when one of them is incomplete.
 *
 * A dependency that does not resolve leaves its whole subtree off the class path, so a scan of the
 * rest would report a clean tree for modules it never saw.
 */
export function parseClassPathReport(
  contents: string,
  plan: readonly PlanEntry[],
): readonly ResolvedClassPath[] {
  const report = JSON.parse(contents) as unknown;
  if (!Array.isArray(report) || report.length !== plan.length) {
    throw new Error(
      `The consumer build reported ${Array.isArray(report) ? String(report.length) : "no"} class paths for a plan of ${String(plan.length)}`,
    );
  }
  const problems: string[] = [];
  const classPaths = (
    report as readonly {
      artifact: string;
      features: readonly string[];
      modules: readonly ResolvedModule[];
      unresolved: readonly string[];
    }[]
  ).map((entry) => {
    for (const failure of entry.unresolved) {
      problems.push(`${classPathLabel(entry)}: ${failure}`);
    }
    if (entry.modules.length === 0) {
      problems.push(`${classPathLabel(entry)} resolved no module outside run.workhorse`);
    }
    return { artifact: entry.artifact, features: entry.features, modules: entry.modules };
  });
  if (problems.length > 0) {
    throw new Error(`The JVM class paths did not resolve completely:\n  ${problems.join("\n  ")}`);
  }
  return classPaths;
}

/** A `--extra group:name:version` coordinate, which a verification run adds to the scan. */
export function parseExtra(coordinate: string): ResolvedModule {
  const parts = coordinate.split(":");
  if (parts.length !== 3 || parts.some((part) => part === "")) {
    throw new Error(`--extra needs group:name:version, received ${coordinate}`);
  }
  const [group, name, version] = parts as [string, string, string];
  return { group, name, version };
}

/** Each distinct module version, with the class paths that reach it. */
export function distinctModules(
  classPaths: readonly ResolvedClassPath[],
): ReadonlyMap<string, { readonly module: ResolvedModule; readonly reachedBy: string[] }> {
  const modules = new Map<string, { module: ResolvedModule; reachedBy: string[] }>();
  for (const classPath of classPaths) {
    for (const module of classPath.modules) {
      const key = `${moduleKey(module)}:${module.version}`;
      const entry = modules.get(key) ?? { module, reachedBy: [] };
      entry.reachedBy.push(classPathLabel(classPath));
      modules.set(key, entry);
    }
  }
  return new Map([...modules].toSorted(([left], [right]) => left.localeCompare(right)));
}

/** The body of an OSV `querybatch` request for these modules. */
export function batchQuery(modules: readonly ResolvedModule[]): unknown {
  return {
    queries: modules.map((module) => ({
      package: { ecosystem: "Maven", name: moduleKey(module) },
      version: module.version,
    })),
  };
}

/** One result of an OSV `querybatch` answer. */
export interface BatchResult {
  readonly ids: readonly string[];
  /** Set when OSV has more advisories for this query than one answer holds. */
  readonly nextPageToken: string | undefined;
}

/** The advisory identifiers for each query, in query order, or a refusal for a malformed answer. */
export function parseBatchAnswer(answer: unknown, queries: number): readonly BatchResult[] {
  const results = (answer as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== queries) {
    throw unavailable(
      `querybatch answered ${Array.isArray(results) ? `${String(results.length)} results` : "without a results list"} for ${String(queries)} queries`,
    );
  }
  return (results as readonly unknown[]).map((entry) => {
    // An answer with no advisory is `{}`. Anything that is not an object, or a `vulns` that is not
    // a list, is a malformed answer, not a clean module.
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw unavailable(`querybatch answered ${JSON.stringify(entry)} instead of a result object`);
    }
    const result = entry as { vulns?: unknown; next_page_token?: unknown };
    if (result.vulns !== undefined && !Array.isArray(result.vulns)) {
      throw unavailable(`querybatch answered a vulns field that is not a list`);
    }
    const ids = ((result.vulns ?? []) as readonly unknown[]).map(
      (vuln) => (vuln as { id?: unknown } | null)?.id,
    );
    if (ids.some((id) => typeof id !== "string" || id === "")) {
      throw unavailable(`querybatch answered an advisory without an identifier`);
    }
    return {
      ids: ids as string[],
      nextPageToken:
        typeof result.next_page_token === "string" && result.next_page_token !== ""
          ? result.next_page_token
          : undefined,
    };
  });
}

/** The parts of an OSV advisory record the scan reads, or a refusal for a malformed record. */
export function parseAdvisoryRecord(record: unknown): AdvisoryRecord {
  const fields = (record ?? {}) as {
    id?: unknown;
    summary?: unknown;
    details?: unknown;
    withdrawn?: unknown;
    affected?: readonly {
      package?: { ecosystem?: string; name?: string };
      ranges?: readonly { events?: readonly { fixed?: string }[] }[];
    }[];
  };
  if (typeof fields.id !== "string" || !Array.isArray(fields.affected)) {
    throw unavailable(`an advisory record has no id or no affected list`);
  }
  const fixedVersions = new Map<string, string[]>();
  for (const affected of fields.affected) {
    if (affected.package?.ecosystem !== "Maven" || !affected.package.name) continue;
    const fixed = fixedVersions.get(affected.package.name) ?? [];
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed && !fixed.includes(event.fixed)) fixed.push(event.fixed);
      }
    }
    fixedVersions.set(affected.package.name, fixed);
  }
  const summary =
    typeof fields.summary === "string" && fields.summary.trim() !== ""
      ? fields.summary.trim()
      : typeof fields.details === "string"
        ? (fields.details.trim().split("\n")[0] ?? "")
        : "";
  return {
    id: fields.id,
    summary,
    withdrawn: typeof fields.withdrawn === "string" && fields.withdrawn !== "",
    fixedVersions,
  };
}

/** Refuse a batch whose canary answer lacks the canary advisory. */
export function checkCanary(result: BatchResult | undefined): void {
  if (!result?.ids.includes(canary.advisory)) {
    throw unavailable(
      `OSV did not report ${canary.advisory} for the canary ${moduleKey(canary.module)}:${canary.module.version} (it reported ${result?.ids.join(", ") || "nothing"})`,
    );
  }
}

/** One finding per advisory and module version, skipping a withdrawn advisory. */
export function collectFindings(
  modules: ReadonlyMap<
    string,
    { readonly module: ResolvedModule; readonly reachedBy: readonly string[] }
  >,
  advisoriesByModule: ReadonlyMap<string, readonly string[]>,
  records: ReadonlyMap<string, AdvisoryRecord>,
): readonly AdvisoryFinding[] {
  const findings: AdvisoryFinding[] = [];
  for (const [key, { module, reachedBy }] of modules) {
    for (const advisory of advisoriesByModule.get(key) ?? []) {
      const record = records.get(advisory);
      if (!record) throw new Error(`No advisory record was read for ${advisory}`);
      if (record.withdrawn) continue;
      findings.push({
        advisory,
        module: moduleKey(module),
        version: module.version,
        reachedBy,
        title: record.summary,
        url: `https://osv.dev/vulnerability/${advisory}`,
        fixedVersions: record.fixedVersions.get(moduleKey(module)) ?? [],
      });
    }
  }
  return findings.toSorted(
    (left, right) =>
      left.module.localeCompare(right.module) || left.advisory.localeCompare(right.advisory),
  );
}

/**
 * The acceptance list, or an error naming every entry that cannot be judged.
 *
 * A missing reason, or a review date that is not a real calendar date such as `never` or
 * `2026-99-99`, would let an advisory pass indefinitely, so such a list is refused before any
 * finding is judged.
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
    for (const field of ["advisory", "module", "reason"] as const) {
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
 * Compare the findings against the acceptance list.
 *
 * Three things fail, as in the npm scan: an advisory nobody has written about, an acceptance whose
 * review date has passed, and an acceptance that no longer matches anything on any class path.
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
      (entry) => entry.advisory === finding.advisory && entry.module === finding.module,
    );
    if (acceptance) {
      matched.add(acceptance);
      continue;
    }
    problems.push({
      headline: `Advisory ${finding.advisory} in ${finding.module} is not accepted in ${acceptanceFileName}`,
      detail: [
        `${finding.module}:${finding.version} on ${finding.reachedBy.join(", ")} · ${finding.title}`,
        `fix:  ${finding.fixedVersions.length > 0 ? `upgrade to ${finding.fixedVersions.join(", ")}` : "no fixed version published"}`,
        `see:  ${finding.url}`,
      ],
    });
  }
  for (const acceptance of acceptances) {
    if (acceptance.reviewBy < today) {
      problems.push({
        headline: `Acceptance of advisory ${acceptance.advisory} was due for review on ${acceptance.reviewBy}`,
        detail: [
          `${acceptance.module} · reason: ${acceptance.reason}`,
          `Take the fix, or restate the reason and move reviewBy forward in ${acceptanceFileName}.`,
        ],
      });
      continue;
    }
    if (!matched.has(acceptance)) {
      problems.push({
        headline: `Acceptance of advisory ${acceptance.advisory} matches nothing OSV reports`,
        detail: [
          acceptance.module,
          `Delete the entry from ${acceptanceFileName}; the advisory is gone from every class path.`,
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
  return `JVM dependency advisories need a decision:\n\n${lines.join("\n")}`;
}

/** Run Gradle, and keep its output for the error when it fails. */
async function gradle(commandArguments: readonly string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("gradle", ["--quiet", ...commandArguments], {
      cwd: repositoryRoot,
      env: withoutPublicationSecrets(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT"
          ? new Error(
              "gradle is not on the PATH. Run `mise install`, then run the command through `mise exec -- <command>`.",
            )
          : error,
      ),
    );
    child.once("exit", (exitCode) =>
      exitCode === 0
        ? resolve()
        : reject(new Error(`gradle exited with ${String(exitCode)}:\n${output.trim()}`)),
    );
  });
}

async function osv(pathname: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${osvApi}${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw unavailable(`${pathname} did not answer: ${describeError(error)}`);
  }
  if (!response.ok) {
    throw unavailable(`${pathname} answered HTTP ${String(response.status)}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw unavailable(`${pathname} answered something other than JSON: ${describeError(error)}`);
  }
}

/** Every advisory identifier for each module, following OSV's pages. */
async function queryAdvisories(
  modules: readonly ResolvedModule[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const queried = [...modules, canary.module];
  const query = batchQuery(queried) as {
    queries: readonly { package: unknown; version: string }[];
  };
  const results = parseBatchAnswer(await osv("/querybatch", query), queried.length);
  checkCanary(results.at(-1));
  const advisories = new Map<string, readonly string[]>();
  for (const [index, module] of modules.entries()) {
    const result = results[index]!;
    const ids = [...result.ids];
    let pageToken = result.nextPageToken;
    while (pageToken !== undefined) {
      const [page] = parseBatchAnswer(
        { results: [await osv("/query", { ...query.queries[index], page_token: pageToken })] },
        1,
      );
      ids.push(...page!.ids);
      pageToken = page!.nextPageToken;
    }
    advisories.set(`${moduleKey(module)}:${module.version}`, [...new Set(ids)]);
  }
  return advisories;
}

/**
 * Publish the three artifacts to a scratch repository, then resolve each of their class paths with
 * the consumer build.
 */
async function resolveClassPaths(workDirectory: string): Promise<readonly ResolvedClassPath[]> {
  const version = jvmTrainVersion(
    await readFile(path.join(jvmDirectory, "gradle.properties"), "utf8"),
  );
  const repository = path.join(workDirectory, "repository");
  await gradle([
    "-p",
    jvmDirectory,
    "--init-script",
    path.join(scanDirectory, "publish.init.gradle.kts"),
    `-Pworkhorse.scanRepository=${repository}`,
    ...publishedArtifacts.map(
      (artifact) => `:${artifact}:publishAllPublicationsToDependencyScanRepository`,
    ),
  ]);
  const features = new Map<string, readonly string[]>();
  for (const artifact of publishedArtifacts) {
    const metadata = path.join(
      repository,
      "run",
      "workhorse",
      artifact,
      version,
      `${artifact}-${version}.module`,
    );
    features.set(artifact, publishedFeatures(artifact, await readFile(metadata, "utf8")));
  }
  const plan = scanPlan(version, features);
  const consumer = path.join(workDirectory, "consumer");
  await cp(scanDirectory, consumer, {
    recursive: true,
    filter: (source) => !source.endsWith(".init.gradle.kts"),
  });
  const planFile = path.join(workDirectory, "plan.json");
  const reportFile = path.join(workDirectory, "report.json");
  await writeFile(planFile, JSON.stringify(plan));
  await gradle([
    "-p",
    consumer,
    `-Pworkhorse.scanRepository=${repository}`,
    `-Pworkhorse.scanPlan=${planFile}`,
    `-Pworkhorse.scanReport=${reportFile}`,
    "resolveRuntimeClassPaths",
  ]);
  return parseClassPathReport(await readFile(reportFile, "utf8"), plan);
}

/**
 * Audit the runtime class paths of the three JVM artifacts.
 *
 * `--extra <group:name:version>` adds one module to the scan, so a verification run can show that a
 * known vulnerable module fails it without a change to the JVM build.
 */
async function auditJvmDependencies(commandArguments: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...commandArguments],
    options: { extra: { type: "string", multiple: true } },
  });
  const extras = (values.extra ?? []).map(parseExtra);
  const acceptances = parseAcceptances(await readFile(acceptanceFile, "utf8"));
  const workDirectory = await mkdtemp(path.join(tmpdir(), "workhorse-jvm-vuln-"));
  try {
    const classPaths = [
      ...(await resolveClassPaths(workDirectory)),
      ...extras.map((module) => ({ artifact: "--extra", features: [], modules: [module] })),
    ];
    const modules = distinctModules(classPaths);
    const advisoriesByModule = await queryAdvisories(
      [...modules.values()].map((entry) => entry.module),
    );
    const records = new Map<string, AdvisoryRecord>();
    for (const advisory of new Set([...advisoriesByModule.values()].flat())) {
      records.set(
        advisory,
        parseAdvisoryRecord(await osv(`/vulns/${encodeURIComponent(advisory)}`)),
      );
    }
    const findings = collectFindings(modules, advisoriesByModule, records);
    const today = new Date().toISOString().slice(0, 10);
    const problems = findProblems(findings, acceptances, today);
    if (problems.length > 0) throw new Error(describeProblems(problems));
    const checked = `${String(modules.size)} modules on ${String(classPaths.length)} runtime class paths of ${publishedArtifacts.join(", ")}`;
    process.stdout.write(
      findings.length === 0
        ? `OSV reports no advisory for ${checked}.\n`
        : `OSV reports ${String(findings.length)} finding${findings.length === 1 ? "" : "s"} for ${checked}, each accepted in ${acceptanceFileName}.\n`,
    );
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    await auditJvmDependencies(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
