/**
 * Upload the JVM bundle to the Central Publisher Portal, and wait until Maven Central publishes it.
 *
 * The upload uses `publishingType=AUTOMATIC`. The Portal validates the deployment and, if it passes,
 * publishes it to Maven Central with no Portal step by a person. Maven Central never deletes a
 * published version, so the protections come before the upload: the `maven-central` environment
 * needs a review, the release consumers ran the bytes of this bundle, and the Portal validates it.
 * ADR 0103 started with `USER_MANAGED`, and SM-1837 changed the stage after two clean releases.
 *
 * The script ends only when the Portal reports `PUBLISHED`, so the `github-release` job announces
 * a version that Maven Central has. It fails on `FAILED`, on an unknown state, and when the
 * deployment does not reach `PUBLISHED` within `pollLimit`.
 *
 * The Portal user token comes only from the `maven-central` environment secrets
 * `MAVEN_CENTRAL_USERNAME` and `MAVEN_CENTRAL_PASSWORD`. The script sends it only in the
 * `Authorization` header to `central.sonatype.com`, and never prints it.
 *
 * A status request can fail for a short time while the Portal keeps the deployment. The script
 * retries a status request that fails with a network error, HTTP 429, or HTTP 5xx, and fails only
 * after `statusAttempts` such failures in a row. When the script fails after the Portal accepted
 * the bundle, the Portal keeps the deployment and can still publish it. "Recover from a failed
 * Maven Central upload" in `docs/compatibility.md` states what the maintainer does then.
 *
 * Before the upload, the script asks the Portal whether Maven Central has each of the three
 * artifacts at the version (SM-1838). The Portal API documents this request as
 * `GET /api/v1/publisher/published`. If Maven Central has all three, a deployment of an earlier run
 * published after that run failed. The script then uploads nothing and succeeds, so a re-run of the
 * job lets `github-release` run. If Maven Central has some of the three but not all, the script
 * fails and uploads nothing.
 *
 * Usage: tsx scripts/upload-maven-central.ts <bundle.zip> <deployment name> <version>
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

const portal = "https://central.sonatype.com/api/v1/publisher";
const pollInterval = 10_000;
/**
 * The time that validation and publishing together may take. The Portal documents no duration for
 * `PUBLISHING`. The Central Maven plugin waits at least 30 minutes for `published`, so this limit
 * is twice that. The job timeout in `release.yml` leaves room for it after the consumers.
 */
const pollLimit = 60 * 60_000;
/**
 * The longest time one status request may take. The deadline of `pollLimit` counts the request
 * time, so a slow or hung request cannot keep the job past the job timeout of `release.yml`.
 */
const statusTimeout = 30_000;
/** The status requests in a row that may fail for a transient reason before the upload fails. */
const statusAttempts = 5;
/**
 * The Maven group and the three artifacts of ADR 0103. `scripts/check-jvm-release.ts` states the
 * same values, and a test keeps the two equal. This script imports nothing from it, so the step
 * that holds the Portal token runs no other module.
 */
export const namespace = "run.workhorse";
export const artifacts = [
  "workhorse",
  "workhorse-kotlin",
  "workhorse-spring-boot-starter",
] as const;

/** The states of a Portal deployment. */
type DeploymentState =
  | "PENDING"
  | "VALIDATING"
  | "VALIDATED"
  | "PUBLISHING"
  | "PUBLISHED"
  | "FAILED";

interface DeploymentStatus {
  readonly deploymentState: DeploymentState;
  readonly errors?: unknown;
}

/** The `Authorization` header the Portal expects for a user token. */
export function authorizationHeader(username: string, password: string): string {
  return `Bearer ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** The upload URL. `AUTOMATIC` publishes a deployment that passes validation. */
export function uploadUrl(name: string): string {
  const query = new URLSearchParams({ name, publishingType: "AUTOMATIC" });
  return `${portal}/upload?${query.toString()}`;
}

/** The URL that asks the Portal whether Maven Central has one artifact at a version. */
export function publishedUrl(name: string, version: string): string {
  const query = new URLSearchParams({ namespace, name, version });
  return `${portal}/published?${query.toString()}`;
}

/**
 * What Maven Central has of the version: `none` uploads the bundle, `all` uploads nothing, and
 * `some` fails. One deployment holds the three artifacts, so `some` is not a state that a re-run
 * can fix.
 */
export function publishedOutcome(published: readonly boolean[]): "none" | "all" | "some" {
  if (published.every((value) => !value)) return "none";
  if (published.every((value) => value)) return "all";
  return "some";
}

/**
 * What a status means for the release stage: `wait` while the Portal validates or publishes,
 * `done` when Maven Central has the deployment, and `failed` otherwise. An `AUTOMATIC` deployment
 * passes through `VALIDATED` on its way to `PUBLISHING`, so `VALIDATED` waits too. `FAILED` and a
 * state that the Portal API does not document fail the stage.
 */
export function deploymentOutcome(status: DeploymentStatus): "wait" | "done" | "failed" {
  switch (status.deploymentState) {
    case "PENDING":
    case "VALIDATING":
    case "VALIDATED":
    case "PUBLISHING":
      return "wait";
    case "PUBLISHED":
      return "done";
    default:
      return "failed";
  }
}

/** A status request that failed. `transient` is true when the next request can succeed. */
interface StatusFailure {
  readonly failure: string;
  readonly transient: boolean;
}

/** HTTP 429 and HTTP 5xx can succeed on the next request. Each other refusal stays. */
function transientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function deploymentStatus(
  fetchImpl: typeof fetch,
  deployment: string,
  authorization: string,
): Promise<DeploymentStatus | StatusFailure> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${portal}/status?${new URLSearchParams({ id: deployment }).toString()}`,
      {
        method: "POST",
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(statusTimeout),
      },
    );
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error), transient: true };
  }
  if (!response.ok) {
    return {
      failure: `HTTP ${String(response.status)}`,
      transient: transientStatus(response.status),
    };
  }
  try {
    return (await response.json()) as DeploymentStatus;
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error), transient: true };
  }
}

async function componentPublished(
  fetchImpl: typeof fetch,
  name: string,
  version: string,
  authorization: string,
): Promise<boolean | StatusFailure> {
  let response: Response;
  try {
    response = await fetchImpl(publishedUrl(name, version), {
      method: "GET",
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(statusTimeout),
    });
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error), transient: true };
  }
  if (!response.ok) {
    return {
      failure: `HTTP ${String(response.status)}`,
      transient: transientStatus(response.status),
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error), transient: true };
  }
  const published = (body as { published?: unknown } | null)?.published;
  if (typeof published !== "boolean") {
    return {
      failure: `an answer without a boolean published: ${JSON.stringify(body)}`,
      transient: false,
    };
  }
  return published;
}

/**
 * Ask the Portal whether Maven Central has each artifact at `version`. A request that fails for a
 * transient reason repeats, as a status request does. Each other failure stops the release stage,
 * because the script must not upload when it does not know the state of Maven Central.
 */
export async function publishedComponents(
  version: string,
  authorization: string,
  fetchImpl: typeof fetch = fetch,
  sleep: (milliseconds: number) => Promise<unknown> = setTimeout,
): Promise<boolean[]> {
  const published: boolean[] = [];
  for (const name of artifacts) {
    for (let failures = 1; ; failures += 1) {
      const answer = await componentPublished(fetchImpl, name, version, authorization);
      if (typeof answer === "boolean") {
        published.push(answer);
        break;
      }
      if (!answer.transient) {
        throw new Error(
          `The Portal refused the request that checks whether Maven Central has ${namespace}:${name}:${version}: ${answer.failure}`,
        );
      }
      if (failures >= statusAttempts) {
        throw new Error(
          `The request that checks whether Maven Central has ${namespace}:${name}:${version} failed ${String(statusAttempts)} times in a row: ${answer.failure}`,
        );
      }
      console.warn(`The Portal request failed (${answer.failure}). The upload tries again.`);
      await sleep(pollInterval);
    }
  }
  return published;
}

function credentials(): { username: string; password: string } {
  const username = process.env.MAVEN_CENTRAL_USERNAME;
  const password = process.env.MAVEN_CENTRAL_PASSWORD;
  if (!username || !password) {
    throw new Error("The upload needs MAVEN_CENTRAL_USERNAME and MAVEN_CENTRAL_PASSWORD");
  }
  return { username, password };
}

/**
 * Upload the bundle and wait for `PUBLISHED`. Return the deployment ID, or `undefined` when Maven
 * Central already has the three artifacts at `version` and the script uploads nothing.
 */
export async function uploadToCentral(
  bundle: string,
  name: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
  sleep: (milliseconds: number) => Promise<unknown> = setTimeout,
  now: () => number = Date.now,
): Promise<string | undefined> {
  const { username, password } = credentials();
  const authorization = authorizationHeader(username, password);
  const published = await publishedComponents(version, authorization, fetchImpl, sleep);
  const coordinates = (names: readonly string[]) =>
    names.map((artifact) => `${namespace}:${artifact}:${version}`).join(", ");
  switch (publishedOutcome(published)) {
    case "all":
      console.log(
        `Maven Central already has ${coordinates(artifacts)}. A deployment of an earlier run published them, so the upload sends nothing.`,
      );
      return undefined;
    case "some":
      throw new Error(
        `Maven Central has ${coordinates(artifacts.filter((_, index) => published[index]))} but not ${coordinates(artifacts.filter((_, index) => !published[index]))}. The upload sends nothing. Read the state of each deployment of the version in the Portal.`,
      );
    case "none":
      break;
  }
  const form = new FormData();
  form.append(
    "bundle",
    new Blob([await readFile(bundle)], { type: "application/zip" }),
    path.basename(bundle),
  );
  const upload = await fetchImpl(uploadUrl(name), {
    method: "POST",
    headers: { Authorization: authorization },
    body: form,
  });
  if (!upload.ok) {
    throw new Error(
      `The Portal refused the upload: HTTP ${String(upload.status)} ${await upload.text()}`,
    );
  }
  const deployment = (await upload.text()).trim();
  console.log(`The Portal accepted deployment ${deployment}`);

  let failures = 0;
  let state: string | undefined;
  const deadline = now() + pollLimit;
  for (;;) {
    const status = await deploymentStatus(fetchImpl, deployment, authorization);
    if ("failure" in status) {
      if (!status.transient) {
        throw new Error(
          `The Portal refused the status request for deployment ${deployment}: ${status.failure}`,
        );
      }
      failures += 1;
      if (failures >= statusAttempts) {
        throw new Error(
          `The Portal status request for deployment ${deployment} failed ${String(statusAttempts)} times in a row: ${status.failure}`,
        );
      }
      console.warn(`The Portal status request failed (${status.failure}). The upload tries again.`);
    } else {
      failures = 0;
      if (status.deploymentState !== state) {
        state = status.deploymentState;
        console.log(`Deployment ${deployment} is ${state}`);
      }
      const outcome = deploymentOutcome(status);
      if (outcome === "done") return deployment;
      if (outcome === "failed") {
        throw new Error(
          `Deployment ${deployment} is ${status.deploymentState}: ${JSON.stringify(status.errors ?? {})}`,
        );
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollInterval, remaining));
  }
  throw new Error(
    `Deployment ${deployment} did not reach PUBLISHED within ${String(pollLimit / 60_000)} minutes. Its last state was ${state ?? "unknown"}, and the Portal can still publish it.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [bundle, name, version] = process.argv.slice(2);
  if (!bundle || !name || !version) {
    process.stderr.write(
      "Usage: tsx scripts/upload-maven-central.ts <bundle.zip> <deployment name> <version>\n",
    );
    process.exitCode = 64;
  } else {
    try {
      const deployment = await uploadToCentral(bundle, name, version);
      if (deployment !== undefined) {
        console.log(
          `Maven Central published deployment ${deployment}. repo1.maven.org can take some minutes to serve it.`,
        );
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
