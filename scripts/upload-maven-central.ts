/**
 * Upload the JVM bundle to the Central Publisher Portal, and wait until the Portal validates it.
 *
 * ADR 0103 uploads with `publishingType=USER_MANAGED`. The Portal validates the deployment and then
 * holds it. Nothing becomes public until the maintainer selects Publish in the Portal, because Maven
 * Central never deletes a published version.
 *
 * The Portal user token comes only from the `maven-central` environment secrets
 * `MAVEN_CENTRAL_USERNAME` and `MAVEN_CENTRAL_PASSWORD`. The script sends it only in the
 * `Authorization` header to `central.sonatype.com`, and never prints it.
 *
 * A status request can fail for a short time while the Portal keeps the deployment. The script
 * retries a status request that fails with a network error, HTTP 429, or HTTP 5xx, and fails only
 * after `statusAttempts` such failures in a row. When the script fails after the Portal accepted
 * the bundle, the Portal keeps the deployment. "Recovering a partially published release" in
 * `docs/compatibility.md` states what the maintainer does then.
 *
 * Usage: tsx scripts/upload-maven-central.ts <bundle.zip> <deployment name>
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

const portal = "https://central.sonatype.com/api/v1/publisher";
const pollInterval = 10_000;
const pollLimit = 15 * 60_000;
/** The status requests in a row that may fail for a transient reason before the upload fails. */
const statusAttempts = 5;

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

/** The upload URL. `USER_MANAGED` keeps the maintainer's Publish step in the Portal. */
export function uploadUrl(name: string): string {
  const query = new URLSearchParams({ name, publishingType: "USER_MANAGED" });
  return `${portal}/upload?${query.toString()}`;
}

/**
 * What a status means for the release stage: `wait` while the Portal works, `done` when it holds a
 * valid deployment, and `failed` otherwise. `PUBLISHING` and `PUBLISHED` mean that someone published
 * a `USER_MANAGED` deployment already, which the stage does not do, so they fail it too.
 */
export function deploymentOutcome(status: DeploymentStatus): "wait" | "done" | "failed" {
  switch (status.deploymentState) {
    case "PENDING":
    case "VALIDATING":
      return "wait";
    case "VALIDATED":
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
      { method: "POST", headers: { Authorization: authorization } },
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

function credentials(): { username: string; password: string } {
  const username = process.env.MAVEN_CENTRAL_USERNAME;
  const password = process.env.MAVEN_CENTRAL_PASSWORD;
  if (!username || !password) {
    throw new Error("The upload needs MAVEN_CENTRAL_USERNAME and MAVEN_CENTRAL_PASSWORD");
  }
  return { username, password };
}

export async function uploadToCentral(
  bundle: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
  sleep: (milliseconds: number) => Promise<unknown> = setTimeout,
): Promise<string> {
  const { username, password } = credentials();
  const authorization = authorizationHeader(username, password);
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
  for (let waited = 0; waited <= pollLimit; waited += pollInterval) {
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
      const outcome = deploymentOutcome(status);
      if (outcome === "done") return deployment;
      if (outcome === "failed") {
        throw new Error(
          `Deployment ${deployment} is ${status.deploymentState}: ${JSON.stringify(status.errors ?? {})}`,
        );
      }
    }
    await sleep(pollInterval);
  }
  throw new Error(
    `Deployment ${deployment} was not validated within ${String(pollLimit / 60_000)} minutes`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [bundle, name] = process.argv.slice(2);
  if (!bundle || !name) {
    process.stderr.write(
      "Usage: tsx scripts/upload-maven-central.ts <bundle.zip> <deployment name>\n",
    );
    process.exitCode = 64;
  } else {
    try {
      const deployment = await uploadToCentral(bundle, name);
      console.log(
        `Deployment ${deployment} is VALIDATED. A maintainer publishes it at https://central.sonatype.com/publishing/deployments.`,
      );
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
