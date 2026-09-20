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
 * **Nothing irreversible runs before the reversible checks pass.** The publisher's ability to
 * authenticate is confirmed, and every target version is checked for absence, before the first
 * `npm publish`. The release this was written for spent its first action on a real publish, met
 * `E404 Not Found - PUT`, and stopped. npm reports an authorization failure as a missing package,
 * so the log named the package while the dead credential went unnamed.
 *
 * Publication authenticates through npm trusted publishing. `npm publish` exchanges the job's
 * GitHub Actions OIDC identity for a short-lived registry credential, and the repository holds no
 * npm token, so nothing else can authenticate the write. That credential does not exist until the
 * irreversible command mints it, so the preflight cannot verify it against the registry. It checks
 * the two conditions the exchange needs instead, and both are knowable in advance: npm performs the
 * exchange only from 11.5.1, and GitHub offers an identity only to a job that asked for one.
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

/** The first npm that exchanges a CI identity for a registry credential. */
const oidcFloor = "11.5.1";

/** Where the publish job that holds the release identity is written down. */
const workflowReference = ".github/workflows/release.yml";

/** Where a maintainer goes when the registry already holds part of this version. */
const recoveryReference = "docs/compatibility.md, “Recovering a partially published release”";

/** Whether the surrounding job can hand npm an identity to exchange, and why it cannot. */
export type OidcIdentity =
  | { readonly offered: true }
  | { readonly offered: false; readonly detail: string };

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

/** The three numbers a released version leads with, or nothing when it leads with something else. */
function releaseNumbers(value: string): number[] {
  return (/^(\d+)\.(\d+)\.(\d+)/.exec(value.trim())?.slice(1) ?? []).map(Number);
}

/**
 * Whether a released version is at least a minimum, over the three numbers npm and Node release
 * under. A version the pattern does not recognise is not a version this comparison can act on.
 */
export function meetsMinimum(version: string, minimum: string): boolean {
  const parsed = releaseNumbers(version);
  if (parsed.length === 0) return false;
  for (const [index, bound] of releaseNumbers(minimum).entries()) {
    const part = parsed[index] ?? 0;
    if (part !== bound) return part > bound;
  }
  return true;
}

function describeVersion(entry: PublishedPackage): string {
  return `${entry.name}@${entry.version}`;
}

/**
 * Every reason not to publish, gathered before anything is written.
 *
 * The target-version check is what recognises a partial release. Reporting nine conflicts one by
 * one would leave the reader to notice that four packages are present and five are not; one problem
 * that names both sides says what actually happened and where the recovery is written down.
 */
export function findPreflightProblems(
  packages: readonly PublishedPackage[],
  npmVersion: string | undefined,
  oidc: OidcIdentity,
  published: RegistryVersions,
): readonly PreflightProblem[] {
  const problems: PreflightProblem[] = [];
  if (npmVersion === undefined) {
    problems.push({
      headline: "npm did not report a version",
      detail: [
        `This release authenticates through OIDC, and only npm ${oidcFloor} and later performs that`,
        "exchange. An npm the preflight cannot run is an npm that cannot publish either.",
      ],
    });
  } else if (!meetsMinimum(npmVersion, oidcFloor)) {
    problems.push({
      headline: `npm ${npmVersion} cannot exchange an OIDC identity`,
      detail: [
        "npm publish mints this release's credential from the job's OIDC identity, and npm added",
        `that exchange in ${oidcFloor}. The workflow passes no token, so an older npm reaches the`,
        "registry as nobody.",
        `Raise node-version in the publish job of ${workflowReference}; Node 24 ships npm 11.`,
      ],
    });
  }
  if (!oidc.offered) {
    problems.push({
      headline: "No OIDC identity is available to publish with",
      detail: [
        oidc.detail,
        "npm publish exchanges that identity for a short-lived registry credential, which is the",
        "only credential this release has. The repository holds no npm token.",
        `Publish from the publish job in ${workflowReference}. It runs GitHub-hosted and holds`,
        "id-token: write.",
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

/** The npm that will do the publishing, or undefined when it could not be asked. */
export async function readNpmVersion(): Promise<string | undefined> {
  const result = await npmCapture(["--version"]);
  if (result.exitCode !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

/**
 * Whether the surrounding job can hand npm an identity to exchange.
 *
 * GitHub sets the two `ACTIONS_ID_TOKEN_REQUEST_*` variables for every step of a job that asked for
 * `id-token: write`, and for no other job. npm reads them, so their absence is the whole failure.
 * `npm publish` treats a missing identity as a reason to carry on unauthenticated, one package at a
 * time, until the registry refuses a write this file cannot undo.
 */
export function readOidcIdentity(env: Readonly<Record<string, string | undefined>>): OidcIdentity {
  if (!env.GITHUB_ACTIONS) {
    return {
      offered: false,
      detail: "npm exchanges an OIDC identity only in CI, and this is not a GitHub Actions run.",
    };
  }
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return {
      offered: false,
      detail:
        "GitHub gave this job no token endpoint. It withholds one from every job that did not ask for id-token: write.",
    };
  }
  return { offered: true };
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
 * Nothing here authenticates. `npm view` reads the registry anonymously, and the two publisher
 * checks read this process and its environment, so a job that could never have published still
 * reports a partial release it has to recover from.
 */
export async function preflight(packages: readonly PublishedPackage[]): Promise<void> {
  const npmVersion = await readNpmVersion();
  const oidc = readOidcIdentity(process.env);
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
  const problems = findPreflightProblems(packages, npmVersion, oidc, published);
  if (problems.length > 0) throw new Error(describeProblems(problems));
  process.stdout.write(
    `Preflight passed: npm ${npmVersion ?? ""} will publish ${String(packages.length)} package(s) ` +
      `with this job's OIDC identity, and none is on the registry at ` +
      `${packages[0]?.version ?? ""}.\n`,
  );
}

/**
 * Publish every package in order, stopping at the first refusal.
 *
 * The order comes from `scripts/packages.ts`: `@stablemates/workhorse` first, because every other
 * package declares it as a peer. Publication output is inherited rather than captured so the
 * provenance notices stay in the task log where a reader expects them.
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

/** Put the ledger where a maintainer finds it without reading the task log. */
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
