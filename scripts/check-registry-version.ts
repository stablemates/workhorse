/**
 * Ask crates.io or RubyGems.org for one version, for the `crates-io` and `rubygems` jobs of
 * `release.yml`.
 *
 * crates.io and RubyGems.org never accept a version twice. A job can fail after its upload, for
 * example at the job timeout. A re-run of that job then failed, because the registry refused the
 * duplicate version, and `github-release` never ran (SM-1860).
 *
 * Before the upload, this script asks the registry whether it serves the exact version. If it does
 * not, the script writes `upload=true`. If it does, the script compares the SHA-256 checksum that
 * the registry states with the checksum of the artifact that the job built. If they agree, an
 * earlier run uploaded these bytes, so the script writes `upload=false` and the job succeeds. If
 * they differ, the script fails and writes nothing, because the registry has other bytes at the
 * version. `cargo package` and `gem build` make the same bytes from the same tag, so a re-run
 * builds the artifact that the earlier run uploaded.
 *
 * With `--wait`, the script runs after the upload. It asks the registry again until the registry
 * serves the version with the checksum of the artifact that the job pushed. It fails if the
 * registry serves a different checksum, or if the version is still missing `waitTimeout` after the
 * first request. The `rubygems` job uses this mode in place of the wait step of `rubygems/release-gem`,
 * because that step crashed after a correct upload (SM-2077).
 *
 * For RubyGems.org, `--wait` also waits for a Sigstore attestation that signs the pushed bytes. When
 * signing fails, the action pushes the gem without an attestation and only writes a warning. That
 * happened from 0.7.1 through 1.0.0, so the wait fails when the attestation is still missing.
 *
 * A request that fails with a network error, HTTP 429, or HTTP 5xx repeats, and the script fails
 * only after `attempts` such failures in a row. Each other failure fails the script.
 *
 * The release workflow runs this with plain `node`, before any dependency is installed, so it
 * imports only Node built-ins.
 *
 * Usage: node scripts/check-registry-version.ts [--wait] <crates-io|rubygems> <name> <version> <artifact>
 */
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

export const registries = ["crates-io", "rubygems"] as const;
export type Registry = (typeof registries)[number];

const labels: Record<Registry, string> = { "crates-io": "crates.io", rubygems: "RubyGems.org" };
/** crates.io refuses an API request without a User-Agent that names the client. */
const userAgent = "workhorse-release (https://github.com/stablemates/workhorse)";
/** The requests in a row that may fail for a transient reason before the script fails. */
const attempts = 5;
const retryInterval = 5_000;
const requestTimeout = 30_000;
/** With `--wait`: the time after the first request at which the wait stops, and the time between requests. */
export const waitTimeout = 600_000;
export const waitInterval = 10_000;
/**
 * The longest time that one request to the registry can take with its repeats: `attempts`
 * requests of at most `requestTimeout`, with `retryInterval` between them.
 */
export const requestBound = attempts * requestTimeout + (attempts - 1) * retryInterval;
const usage =
  "Usage: node scripts/check-registry-version.ts [--wait] <crates-io|rubygems> <name> <version> <artifact>\n";

/** The URL at which the registry states one version and its SHA-256 checksum. */
export function versionUrl(registry: Registry, name: string, version: string): string {
  const [encodedName, encodedVersion] = [name, version].map(encodeURIComponent);
  if (registry === "crates-io")
    return `https://crates.io/api/v1/crates/${encodedName}/${encodedVersion}`;
  return `https://rubygems.org/api/v2/rubygems/${encodedName}/versions/${encodedVersion}.json?platform=ruby`;
}

/** The URL at which RubyGems.org lists the Sigstore attestations of one version of a gem. */
export function attestationsUrl(name: string, version: string): string {
  return `https://rubygems.org/api/v1/attestations/${encodeURIComponent(`${name}-${version}`)}.json`;
}

/**
 * The SHA-256 checksums, in hex, that the Sigstore bundles in an attestations answer of
 * RubyGems.org sign. A bundle signs either a message digest or the subjects of a DSSE statement.
 */
export function attestedChecksums(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((entry: unknown) => {
    const bundle = entry as {
      messageSignature?: { messageDigest?: { algorithm?: unknown; digest?: unknown } };
      dsseEnvelope?: { payload?: unknown };
    } | null;
    const digest = bundle?.messageSignature?.messageDigest;
    if (digest?.algorithm === "SHA2_256" && typeof digest.digest === "string")
      return [Buffer.from(digest.digest, "base64").toString("hex")];
    const payload = bundle?.dsseEnvelope?.payload;
    if (typeof payload !== "string") return [];
    try {
      const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as {
        subject?: { digest?: { sha256?: unknown } }[];
      };
      return (statement.subject ?? []).flatMap((subject) =>
        typeof subject.digest?.sha256 === "string" ? [subject.digest.sha256] : [],
      );
    } catch {
      return [];
    }
  });
}

/** The SHA-256 checksum in a version answer of the registry, if it has one. */
function statedChecksum(registry: Registry, body: unknown): string | undefined {
  const value =
    registry === "crates-io"
      ? (body as { version?: { checksum?: unknown } } | null)?.version?.checksum
      : (body as { sha?: unknown } | null)?.sha;
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

export interface CheckOptions {
  readonly registry: Registry;
  readonly name: string;
  readonly version: string;
  /** The `.crate` or `.gem` file that the job built. */
  readonly artifact: string;
  readonly fetch?: typeof fetch;
  readonly delay?: (milliseconds: number) => Promise<unknown>;
}

export interface CheckOutcome {
  /** True when the registry does not serve the version, so the job uploads the artifact. */
  readonly upload: boolean;
  readonly message: string;
}

/** A request that failed. `transient` is true when the next request can succeed. */
interface RequestFailure {
  readonly failure: string;
  readonly transient: boolean;
}

type Answer =
  | { readonly status: "missing" }
  | { readonly status: "served"; readonly body: unknown };

async function requestVersion(
  fetchImpl: typeof fetch,
  url: string,
): Promise<Answer | RequestFailure> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": userAgent },
      signal: AbortSignal.timeout(requestTimeout),
    });
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error), transient: true };
  }
  if (response.status === 404) return { status: "missing" };
  if (!response.ok) {
    return {
      failure: `HTTP ${String(response.status)}`,
      transient: response.status === 429 || response.status >= 500,
    };
  }
  try {
    return { status: "served", body: await response.json() };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error), transient: true };
  }
}

/** The artifact, the registry's state for the version, and the text that names both. */
interface Reading {
  readonly label: string;
  readonly file: string;
  readonly built: string;
  /** The checksum that the registry states, or undefined when it does not serve the version. */
  readonly served: string | undefined;
}

async function checksumOf(artifact: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
}

/**
 * The end of a wait: no request starts that could end after `deadline` on the clock `now`. One
 * poll of the wait makes two requests, each with repeats, so a check of the deadline between polls
 * does not bound the wait.
 */
interface Limit {
  readonly now: () => number;
  readonly deadline: number;
}

/**
 * Ask the registry one URL, with repeats for transient failures. Fail on any other failure, and
 * fail before a request that could end after the deadline of `limit`.
 */
async function ask(options: CheckOptions, url: string, limit?: Limit): Promise<Answer> {
  const fetchImpl = options.fetch ?? fetch;
  const delay = options.delay ?? setTimeout;
  let answer: Answer | RequestFailure | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pause = attempt > 1 ? retryInterval : 0;
    if (limit && limit.now() + pause + requestTimeout > limit.deadline)
      throw new Error(
        `${labels[options.registry]} did not answer for ${options.name} ${options.version} at ${url} ` +
          `before the end of the wait${answer && "failure" in answer ? `: ${answer.failure}` : ""}`,
      );
    if (attempt > 1) await delay(retryInterval);
    answer = await requestVersion(fetchImpl, url);
    if (!("failure" in answer) || !answer.transient) break;
    process.stderr.write(
      `Request ${String(attempt)} of ${String(attempts)} to ${url} failed: ${answer.failure}\n`,
    );
  }
  if (answer === undefined || "failure" in answer)
    throw new Error(
      `${labels[options.registry]} did not answer for ${options.name} ${options.version} at ${url}: ${answer?.failure}`,
    );
  return answer;
}

/** True when RubyGems.org lists a Sigstore attestation that signs the bytes with checksum `built`. */
async function attested(options: CheckOptions, built: string, limit?: Limit): Promise<boolean> {
  const answer = await ask(options, attestationsUrl(options.name, options.version), limit);
  return answer.status === "served" && attestedChecksums(answer.body).includes(built);
}

/**
 * Ask the registry for the version once, with repeats for transient failures. Fail when the
 * registry serves the version with no checksum or with a checksum other than `built`.
 */
async function readVersion(options: CheckOptions, built: string, limit?: Limit): Promise<Reading> {
  const { registry, name, version, artifact } = options;
  const label = labels[registry];
  const file = path.basename(artifact);
  const answer = await ask(options, versionUrl(registry, name, version), limit);
  if (answer.status === "missing") return { label, file, built, served: undefined };

  const served = statedChecksum(registry, answer.body);
  if (served === undefined)
    throw new Error(
      `${label} answered for ${name} ${version} without a SHA-256 checksum: ${JSON.stringify(answer.body)}`,
    );
  if (served !== built)
    throw new Error(
      `${label} already serves ${name} ${version} with SHA-256 ${served}, but ${file} has SHA-256 ${built}. ` +
        `${label} never replaces a version, so this job cannot publish these bytes. ` +
        "Find out which build reached the registry before you continue the release.",
    );
  return { label, file, built, served };
}

/** Ask the registry for the version and compare its checksum with the built artifact. */
export async function checkRegistryVersion(options: CheckOptions): Promise<CheckOutcome> {
  const { name, version } = options;
  const built = await checksumOf(options.artifact);
  const reading = await readVersion(options, built);
  if (reading.served === undefined)
    return {
      upload: true,
      message: `${reading.label} does not serve ${name} ${version}, so the job uploads it`,
    };
  // A re-run after an upload without an attestation skips the upload and the wait, so the check
  // asks for the attestation here too.
  const rubygems = options.registry === "rubygems";
  if (rubygems && !(await attested(options, built)))
    throw new Error(
      `${reading.label} already serves ${name} ${version} with the checksum of ${reading.file}, but lists no ` +
        "Sigstore attestation of it. An earlier run pushed the gem without an attestation. " +
        `${reading.label} never replaces a version, so fix the signer and release a new candidate.`,
    );
  return {
    upload: false,
    message:
      `${reading.label} already serves ${name} ${version} with SHA-256 ${reading.served}, the checksum of ${reading.file}` +
      (rubygems ? ", and a Sigstore attestation of the same bytes" : "") +
      ". An earlier run uploaded it, so the job uploads nothing",
  };
}

export interface WaitOptions extends CheckOptions {
  /** The time after the first request at which the wait stops asking the registry. */
  readonly timeout?: number;
  /** The time between two requests that find the version missing. */
  readonly interval?: number;
  /** The clock in milliseconds. */
  readonly now?: () => number;
}

/**
 * After an upload, ask the registry until it serves the version with the checksum of the pushed
 * artifact. For RubyGems.org, also wait until it lists a Sigstore attestation of those bytes.
 * Return a message when it does. Fail when it serves other bytes, or when the version or the
 * attestation is still missing at `timeout` after the first request.
 *
 * Each request can repeat for transient failures, as in the check before the upload. No request
 * starts that could end more than `requestBound` after `timeout`, so the wait ends by then, also
 * when each poll asks for the version and for the attestations.
 */
export async function awaitRegistryVersion(options: WaitOptions): Promise<string> {
  const { name, version } = options;
  const delay = options.delay ?? setTimeout;
  const now = options.now ?? Date.now;
  const timeout = options.timeout ?? waitTimeout;
  const interval = options.interval ?? waitInterval;
  const built = await checksumOf(options.artifact);
  const label = labels[options.registry];
  const start = now();
  const limit: Limit = { now, deadline: start + timeout + requestBound };
  for (let request = 1; ; request += 1) {
    const reading = await readVersion(options, built, limit);
    const served = reading.served !== undefined;
    const signed =
      served && (options.registry !== "rubygems" || (await attested(options, built, limit)));
    if (signed) {
      const message = `${label} serves ${name} ${version} with SHA-256 ${reading.served}, the checksum of ${reading.file}`;
      return options.registry === "rubygems"
        ? `${message}, and a Sigstore attestation of the same bytes`
        : message;
    }
    const elapsed = now() - start;
    const seconds = String(Math.round(elapsed / 1000));
    process.stdout.write(
      served
        ? `Request ${String(request)} at ${seconds} s: ${label} serves ${name} ${version} without an attestation of ${reading.file} yet\n`
        : `Request ${String(request)} at ${seconds} s: ${label} does not serve ${name} ${version} yet\n`,
    );
    if (elapsed + interval > timeout)
      throw new Error(
        served
          ? `${label} serves ${name} ${version} with the checksum of ${reading.file}, but lists no ` +
              `Sigstore attestation of it after ${String(request)} requests in ${seconds} s. ` +
              "The push fell back to an upload without an attestation. Read the warning of the " +
              `publish step. ${label} never replaces a version, so fix the signer before the next release.`
          : `${label} did not serve ${name} ${version} after ${String(request)} requests in ` +
              `${seconds} s. ` +
              `Look for the version on ${label} before you re-run the job.`,
      );
    await delay(interval);
  }
}

export interface RunOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly delay?: (milliseconds: number) => Promise<unknown>;
}

/** Run the check from command-line arguments, and return the exit code. */
export async function runCheck(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const environment = options.environment ?? process.env;
  const wait = argv[0] === "--wait";
  const [registry, name, version, artifact, ...rest] = wait ? argv.slice(1) : argv;
  if (
    !registries.includes(registry as Registry) ||
    !name ||
    !version ||
    !artifact ||
    rest.length > 0
  ) {
    process.stderr.write(usage);
    return 64;
  }
  const summary = async (line: string) => {
    if (environment.GITHUB_STEP_SUMMARY)
      await appendFile(environment.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  const check = {
    registry: registry as Registry,
    name,
    version,
    artifact,
    fetch: options.fetch,
    delay: options.delay,
  };
  try {
    if (wait) {
      const message = await awaitRegistryVersion(check);
      process.stdout.write(`::notice::${message}\n`);
      await summary(message);
      return 0;
    }
    const outcome = await checkRegistryVersion(check);
    if (outcome.upload) {
      process.stdout.write(`${outcome.message}\n`);
    } else {
      process.stdout.write(`::notice::${outcome.message}\n`);
      await summary(outcome.message);
    }
    if (environment.GITHUB_OUTPUT)
      await appendFile(environment.GITHUB_OUTPUT, `upload=${String(outcome.upload)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::${message}\n`);
    await summary(message);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exitCode = await runCheck(process.argv.slice(2));
}
