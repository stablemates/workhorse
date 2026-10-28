/**
 * Decide whether the `crates-io` or `rubygems` job of `release.yml` uploads its artifact (SM-1860).
 *
 * crates.io and RubyGems.org never accept a version twice. A job can fail after its upload, for
 * example in the wait step of `rubygems/release-gem` or at the job timeout. A re-run of that job
 * then failed, because the registry refused the duplicate version, and `github-release` never ran.
 *
 * Before the upload, this script asks the registry whether it serves the exact version. If it does
 * not, the script writes `upload=true`. If it does, the script compares the SHA-256 checksum that
 * the registry states with the checksum of the artifact that the job built. If they agree, an
 * earlier run uploaded these bytes, so the script writes `upload=false` and the job succeeds. If
 * they differ, the script fails and writes nothing, because the registry has other bytes at the
 * version. `cargo package` and `gem build` make the same bytes from the same tag, so a re-run
 * builds the artifact that the earlier run uploaded.
 *
 * A request that fails with a network error, HTTP 429, or HTTP 5xx repeats, and the script fails
 * only after `attempts` such failures in a row. Each other failure fails the script.
 *
 * The release workflow runs this with plain `node`, before any dependency is installed, so it
 * imports only Node built-ins.
 *
 * Usage: node scripts/check-registry-version.ts <crates-io|rubygems> <name> <version> <artifact>
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

/** The URL at which the registry states one version and its SHA-256 checksum. */
export function versionUrl(registry: Registry, name: string, version: string): string {
  const [encodedName, encodedVersion] = [name, version].map(encodeURIComponent);
  if (registry === "crates-io")
    return `https://crates.io/api/v1/crates/${encodedName}/${encodedVersion}`;
  return `https://rubygems.org/api/v2/rubygems/${encodedName}/versions/${encodedVersion}.json?platform=ruby`;
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

/** Ask the registry for the version and compare its checksum with the built artifact. */
export async function checkRegistryVersion(options: CheckOptions): Promise<CheckOutcome> {
  const { registry, name, version, artifact } = options;
  const fetchImpl = options.fetch ?? fetch;
  const delay = options.delay ?? setTimeout;
  const label = labels[registry];
  const built = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  const url = versionUrl(registry, name, version);

  let answer: Answer | RequestFailure | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await delay(retryInterval);
    answer = await requestVersion(fetchImpl, url);
    if (!("failure" in answer) || !answer.transient) break;
    process.stderr.write(
      `Request ${String(attempt)} of ${String(attempts)} to ${url} failed: ${answer.failure}\n`,
    );
  }
  if (answer === undefined || "failure" in answer)
    throw new Error(`${label} did not answer for ${name} ${version} at ${url}: ${answer?.failure}`);
  if (answer.status === "missing")
    return {
      upload: true,
      message: `${label} does not serve ${name} ${version}, so the job uploads it`,
    };

  const served = statedChecksum(registry, answer.body);
  if (served === undefined)
    throw new Error(
      `${label} answered for ${name} ${version} without a SHA-256 checksum: ${JSON.stringify(answer.body)}`,
    );
  const file = path.basename(artifact);
  if (served !== built)
    throw new Error(
      `${label} already serves ${name} ${version} with SHA-256 ${served}, but ${file} has SHA-256 ${built}. ` +
        `${label} never replaces a version, so this job cannot publish these bytes. ` +
        "Find out which build reached the registry before you continue the release.",
    );
  return {
    upload: false,
    message:
      `${label} already serves ${name} ${version} with SHA-256 ${served}, the checksum of ${file}. ` +
      "An earlier run uploaded it, so the job uploads nothing",
  };
}

export interface RunOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly delay?: (milliseconds: number) => Promise<unknown>;
}

/** Run the check from command-line arguments, and return the exit code. */
export async function runCheck(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const environment = options.environment ?? process.env;
  const [registry, name, version, artifact, ...rest] = argv;
  if (
    !registries.includes(registry as Registry) ||
    !name ||
    !version ||
    !artifact ||
    rest.length > 0
  ) {
    process.stderr.write(
      "Usage: node scripts/check-registry-version.ts <crates-io|rubygems> <name> <version> <artifact>\n",
    );
    return 64;
  }
  const summary = async (line: string) => {
    if (environment.GITHUB_STEP_SUMMARY)
      await appendFile(environment.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  try {
    const outcome = await checkRegistryVersion({
      registry: registry as Registry,
      name,
      version,
      artifact,
      fetch: options.fetch,
      delay: options.delay,
    });
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
