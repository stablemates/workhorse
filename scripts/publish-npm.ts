import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { type PublishedPackage, publishedPackages, repositoryRoot } from "./packages.js";

/**
 * The npm publication stage: a preflight the release can fail safely, then a loop that records what
 * it did.
 *
 * Publishing to npm is the one irreversible step in the release train. A version that reaches the
 * registry can never be republished, and unpublish stops being available after 72 hours. A bare
 * loop that fails on package five therefore leaves four packages at the new version, five at the
 * old one, and no way back.
 * [ADR 0050](../docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md) requires one
 * version across npm, PyPI, and the Go module proxy, so the recovery is re-cutting the whole train
 * at a higher patch.
 *
 * Two properties follow from that, and they are what this file is.
 *
 * **Nothing irreversible runs before the reversible checks pass.** The credential is verified
 * against the registry, and every target version is checked for absence, before the first
 * `npm publish`. The release this was written for spent its first action on a real publish, met
 * `E404 Not Found - PUT`, and stopped. npm reports an authorization failure as a missing package,
 * so the log named the package while the expired token went unnamed.
 *
 * **A failure says what the registry now holds.** The loop keeps a ledger and prints it on the way
 * out, naming every package that published and every one that did not, with versions. A maintainer
 * recovering a half-published release reads that ledger instead of inferring registry state from
 * whichever npm command logged last.
 *
 * The preflight also closes a smaller hole. `npm publish --provenance` signs to the public Sigstore
 * transparency log before it attempts the registry write, so every failed attempt leaves a
 * permanent public attestation for a tarball nobody can install. npm decides that order, not this
 * script; refusing to start is what keeps the common failures out of that log.
 */

/** Where the build job's tarballs are downloaded, relative to the repository root. */
const tarballDirectory = "dist-tarballs";

/** The credential the workflow passes as `NODE_AUTH_TOKEN`, named in every failure it causes. */
const credentialName = "NPM_TOKEN";

/** Where a maintainer goes when the registry already holds part of this version. */
const recoveryReference = "docs/compatibility.md, “Recovering a partially published release”";

/** Whether the registry accepted the credential, and who it says the credential is. */
export type Credential =
  | { readonly accepted: true; readonly username: string }
  | { readonly accepted: false; readonly detail: string };

/**
 * What the registry disclosed about one scope's package permissions.
 *
 * The three cases are not three shades of failure. `listed` is an answer to act on: the registry
 * named the packages this credential may write, so anything absent from it is a package the
 * credential cannot publish. `refused` is the credential failing again, one call later. `undisclosed`
 * is the registry declining to answer at all, which some token types produce for a credential that
 * publishes perfectly well — so it is reported and does not block. Blocking a release on a question
 * the registry would not answer trades a rare catastrophe for a frequent one.
 */
export type ScopeAccess =
  | { readonly kind: "listed"; readonly permissions: Readonly<Record<string, string>> }
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "undisclosed"; readonly detail: string };

/**
 * Versions the registry serves for a package, or `undefined` when it has never been published.
 *
 * A registry that could not be read is neither: {@link readPublishedVersions} throws rather than
 * report an unread package as absent, for the reason `scripts/audit-npm-dependencies.ts` refuses an
 * unusable audit report. A query that never ran is not a clean answer.
 */
export type RegistryVersions = ReadonlyMap<string, readonly string[] | undefined>;

/** One reason the preflight refuses to publish, phrased for the maintainer who has to act on it. */
export interface PreflightProblem {
  readonly headline: string;
  readonly detail: readonly string[];
}

/** What the publish loop did, in the order it did it. */
export interface PublishLedger {
  /** Packages the registry accepted. These versions are permanent. */
  readonly published: readonly PublishedPackage[];
  /** The package the loop stopped on, absent when every package published. */
  readonly failure?: { readonly entry: PublishedPackage; readonly detail: string };
  /** Packages the loop never reached. */
  readonly pending: readonly PublishedPackage[];
}

/** The scope in a package name, for example `@stablemates`, or undefined when it has none. */
export function packageScope(name: string): string | undefined {
  return /^(@[^/]+)\//.exec(name)?.[1];
}

/** Every scope the published packages live in, in first-seen order. */
export function publishedScopes(packages: readonly PublishedPackage[]): readonly string[] {
  const scopes: string[] = [];
  for (const entry of packages) {
    const scope = packageScope(entry.name);
    if (scope && !scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

function describeVersion(entry: PublishedPackage): string {
  return `${entry.name}@${entry.version}`;
}

/**
 * Every reason not to publish, gathered before anything is written.
 *
 * The version check is the half that recognises a partial release. Reporting nine conflicts one by
 * one would leave the reader to notice that four packages are present and five are not; one problem
 * that names both sides says what actually happened and where the recovery is written down.
 */
export function findPreflightProblems(
  packages: readonly PublishedPackage[],
  credential: Credential,
  access: ReadonlyMap<string, ScopeAccess>,
  published: RegistryVersions,
): readonly PreflightProblem[] {
  const problems: PreflightProblem[] = [];
  if (!credential.accepted) {
    problems.push({
      headline: `The registry refused the ${credentialName} credential`,
      detail: [
        `npm whoami: ${credential.detail || "no output"}`,
        `Nothing was published. Rotate ${credentialName} in the npm environment, then re-run the`,
        "release workflow for this tag.",
      ],
    });
  }
  for (const [scope, answer] of access) {
    if (answer.kind !== "refused") continue;
    problems.push({
      headline: `${credentialName} cannot read the ${scope} scope`,
      detail: [
        `npm access list packages ${scope}: ${answer.detail || "no output"}`,
        `The credential authenticates but the registry will not disclose ${scope} to it, so it`,
        `cannot be trusted to publish into it. Rotate ${credentialName} and re-run.`,
      ],
    });
  }
  for (const entry of packages) {
    const scope = packageScope(entry.name);
    const answer = scope ? access.get(scope) : undefined;
    if (answer?.kind !== "listed") continue;
    // A package the registry knows about and did not list is a package this credential may not
    // write. A package that has never been published cannot appear in any listing, so its absence
    // says nothing.
    const permission = answer.permissions[entry.name];
    if (permission === "read-write") continue;
    if (permission === undefined && published.get(entry.name) === undefined) continue;
    problems.push({
      headline:
        permission === undefined
          ? `${credentialName} may not publish ${entry.name}`
          : `${credentialName} has ${permission} access to ${entry.name}`,
      detail: [
        `npm access list packages ${scope ?? ""} names ${String(Object.keys(answer.permissions).length)} package(s) this credential may reach.`,
        `Grant it read-write on ${entry.name}, or rotate ${credentialName} for one that has it.`,
      ],
    });
  }
  const conflicting = packages.filter((entry) =>
    published.get(entry.name)?.includes(entry.version),
  );
  if (conflicting.length === 0) return problems;
  const absent = packages.filter((entry) => !conflicting.includes(entry));
  const version = conflicting[0]?.version ?? "";
  problems.push({
    headline:
      absent.length === 0
        ? `Every package is already published at ${version}`
        : `The registry already holds ${String(conflicting.length)} of ${String(packages.length)} packages at ${version}`,
    detail: [
      "Already on the registry:",
      ...conflicting.map((entry) => `  ${describeVersion(entry)}`),
      ...(absent.length === 0
        ? []
        : [
            "Not on the registry:",
            ...absent.map((entry) => `  ${describeVersion(entry)}`),
            `This is a partial ${version} release from an earlier attempt. Re-running cannot`,
            "complete it: npm refuses a version that has ever existed.",
            `Recover it with ${recoveryReference}.`,
          ]),
    ],
  });
  return problems;
}

/** Assemble one message from every problem, in the shape the other release gates report findings. */
export function describeProblems(problems: readonly PreflightProblem[]): string {
  const lines: string[] = [];
  for (const problem of problems) {
    lines.push(problem.headline);
    for (const line of problem.detail) lines.push(`  ${line}`);
    lines.push("");
  }
  return `The npm publish preflight refused to write anything:\n\n${lines.join("\n")}`;
}

/**
 * The ledger as a maintainer reads it.
 *
 * The failing case leads with the permanent half, because that is the part no later command can
 * change and the part that decides what recovery costs.
 */
export function describeLedger(ledger: PublishLedger): string {
  const published = ledger.published.map((entry) => `  ${describeVersion(entry)}`);
  if (!ledger.failure) {
    const version = ledger.published[0]?.version ?? "";
    return [
      `Published ${String(ledger.published.length)} package(s) at ${version}:`,
      ...published,
    ].join("\n");
  }
  const attempted = ledger.published.length + 1;
  const total = attempted + ledger.pending.length;
  const version = ledger.failure.entry.version;
  return [
    `npm publication stopped at package ${String(attempted)} of ${String(total)}.`,
    "",
    published.length === 0
      ? "Published: nothing. The registry is unchanged."
      : "Published, and permanent — npm never accepts these versions again:",
    ...published,
    "",
    "Failed:",
    `  ${describeVersion(ledger.failure.entry)}`,
    `  ${ledger.failure.detail}`,
    "",
    ...(ledger.pending.length === 0
      ? []
      : ["Not attempted:", ...ledger.pending.map((entry) => `  ${describeVersion(entry)}`), ""]),
    ...(published.length === 0
      ? ["No version was published, so this tag can be released again once the failure is fixed."]
      : [
          `npm now holds a partial ${version} release. Re-running cannot complete it, because npm`,
          `refuses a version that has ever existed. Recover it with ${recoveryReference}.`,
        ]),
  ].join("\n");
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

async function npmCapture(args: readonly string[]): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn("npm", [...args], {
      cwd: repositoryRoot,
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
 * npm error codes that mean the registry rejected the credential rather than the request.
 *
 * `E404` is deliberately not here. npm answers an unauthorized write to a scoped package with a
 * 404 so the registry does not disclose that the package exists, which is exactly the ambiguity
 * this preflight exists to resolve — on a read, a 404 really is absence.
 */
const credentialRefusals = ["E401", "E403", "ENEEDAUTH", "EAUTHUNKNOWN", "EOTP"];

function refusesCredential(output: string): boolean {
  return credentialRefusals.some((code) => output.includes(code));
}

/**
 * npm's diagnostics as one line, minus what it says on every run.
 *
 * A failure message is only useful if the reader can see the reason in it. npm surrounds that
 * reason with deprecation warnings and a path to a log file nobody has, and a preflight failure
 * quotes the result into a report that is already several lines deep.
 */
export function condenseDiagnostics(output: string): string {
  return output
    .split("\n")
    .map((line) => line.trim().replace(/^npm error /, ""))
    .filter(
      (line) =>
        line && !line.startsWith("npm warn") && !line.includes("A complete log of this run"),
    )
    .join("; ");
}

/** Ask the registry who the credential is. An expired or malformed token fails here and nowhere else. */
export async function readCredential(): Promise<Credential> {
  const result = await npmCapture(["whoami"]);
  if (result.exitCode === 0 && result.stdout.trim()) {
    return { accepted: true, username: result.stdout.trim() };
  }
  return { accepted: false, detail: condenseDiagnostics(result.stderr || result.stdout) };
}

/** Ask the registry which packages in a scope the credential may write. */
export async function readScopeAccess(scope: string): Promise<ScopeAccess> {
  const result = await npmCapture(["access", "list", "packages", scope, "--json"]);
  if (result.exitCode === 0) {
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { kind: "listed", permissions: parsed as Record<string, string> };
      }
    } catch {
      // Fall through: an unparseable answer is an answer the preflight cannot act on.
    }
    return { kind: "undisclosed", detail: "the registry returned no package permissions" };
  }
  const detail = condenseDiagnostics(result.stderr || result.stdout);
  return refusesCredential(detail)
    ? { kind: "refused", detail }
    : {
        kind: "undisclosed",
        detail: detail || `npm access exited with ${String(result.exitCode)}`,
      };
}

/** The versions `npm view` reports, normalised from the string it prints for a single version. */
export function parseVersions(payload: string): readonly string[] {
  if (!payload.trim()) return [];
  const parsed = JSON.parse(payload) as unknown;
  if (typeof parsed === "string") return [parsed];
  if (Array.isArray(parsed))
    return parsed.filter((entry): entry is string => typeof entry === "string");
  throw new Error(`Expected a version list, received ${payload.trim()}`);
}

/** What the registry serves for one package, or undefined when it has never been published. */
export async function readPublishedVersions(name: string): Promise<readonly string[] | undefined> {
  const result = await npmCapture(["view", name, "versions", "--json"]);
  if (result.exitCode === 0) return parseVersions(result.stdout);
  const detail = condenseDiagnostics(result.stderr || result.stdout);
  if (detail.includes("E404")) return undefined;
  throw new Error(
    `npm view ${name} versions could not read the registry: ${detail || `exited with ${String(result.exitCode)}`}. ` +
      "Nothing was published, and no target version was checked. Re-run when the registry answers.",
  );
}

/**
 * Everything the preflight needs, then the decision.
 *
 * The version reads do not need the credential, so they run whichever way `npm whoami` went and a
 * dead token still reports a partial release. The access reads do need it, and asking a refused
 * credential a second question only restates the first answer.
 */
export async function preflight(packages: readonly PublishedPackage[]): Promise<void> {
  const credential = await readCredential();
  const published = new Map<string, readonly string[] | undefined>(
    await Promise.all(
      packages.map(
        async (entry) =>
          [entry.name, await readPublishedVersions(entry.name)] as const satisfies readonly [
            string,
            readonly string[] | undefined,
          ],
      ),
    ),
  );
  const access = new Map<string, ScopeAccess>();
  if (credential.accepted) {
    for (const scope of publishedScopes(packages)) access.set(scope, await readScopeAccess(scope));
  }
  const problems = findPreflightProblems(packages, credential, access, published);
  if (problems.length > 0) throw new Error(describeProblems(problems));
  for (const [scope, answer] of access) {
    if (answer.kind !== "undisclosed") continue;
    process.stdout.write(
      `Note: the registry did not disclose ${scope} package permissions (${answer.detail}). ` +
        `${credentialName} authenticated, and per-package write access was not verified.\n`,
    );
  }
  process.stdout.write(
    `Preflight passed: ${credential.accepted ? credential.username : "unknown"} may publish ` +
      `${String(packages.length)} package(s), and none is on the registry at ` +
      `${packages[0]?.version ?? ""}.\n`,
  );
}

/**
 * Publish every package in order, stopping at the first refusal.
 *
 * The order comes from `scripts/packages.ts`: `@stablemates/workhorse` first, because every other
 * package declares it as a peer. Publication output is inherited rather than captured so the
 * provenance notices stay in the job log where a reader expects them.
 */
export async function publishAll(packages: readonly PublishedPackage[]): Promise<PublishLedger> {
  const published: PublishedPackage[] = [];
  for (const [index, entry] of packages.entries()) {
    const tarball = path.join(repositoryRoot, tarballDirectory, entry.tarball);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("npm", ["publish", "--provenance", "--access", "public", tarball], {
        cwd: repositoryRoot,
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    if (exitCode === 0) {
      published.push(entry);
      continue;
    }
    return {
      published,
      failure: { entry, detail: `npm publish ${entry.tarball} exited with ${String(exitCode)}` },
      pending: packages.slice(index + 1),
    };
  }
  return { published, pending: [] };
}

/** Put the ledger where a maintainer finds it without reading the job log. */
async function recordSummary(report: string): Promise<void> {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  await appendFile(summary, `## npm publication\n\n\`\`\`\n${report}\n\`\`\`\n`);
}

export async function publishNpm(): Promise<void> {
  const packages = await publishedPackages();
  if (packages.length === 0) throw new Error("No publishable npm packages were found");
  await preflight(packages);
  const ledger = await publishAll(packages);
  const report = describeLedger(ledger);
  await recordSummary(report);
  if (ledger.failure) throw new Error(report);
  process.stdout.write(`${report}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    await publishNpm();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
