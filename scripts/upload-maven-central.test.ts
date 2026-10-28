import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { group, publishedArtifacts } from "./check-jvm-release.js";
import {
  artifacts,
  authorizationHeader,
  deploymentOutcome,
  namespace,
  publishedComponents,
  publishedOutcome,
  publishedUrl,
  uploadToCentral,
  uploadUrl,
} from "./upload-maven-central.js";

/** Answer each check of Maven Central with `published: false`, and pass every other request on. */
function unpublished(fetchImpl: typeof fetch): typeof fetch {
  return async (url, init) =>
    String(url).includes("/published?")
      ? Response.json({ published: false })
      : fetchImpl(url, init);
}

/** A Portal that has the artifacts in `published`, and records each request. */
function portalWith(published: readonly string[]) {
  return vi.fn<typeof fetch>(async (url) => {
    const address = new URL(String(url));
    if (address.pathname.endsWith("/published")) {
      return Response.json({ published: published.includes(address.searchParams.get("name")!) });
    }
    if (address.pathname.endsWith("/upload")) return new Response("deployment-9");
    return Response.json({ deploymentState: "PUBLISHED" });
  });
}

describe("the Central Portal upload", () => {
  let directory: string;
  let bundle: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "workhorse-central-upload-"));
    bundle = path.join(directory, "bundle.zip");
    await writeFile(bundle, "zip");
    vi.stubEnv("MAVEN_CENTRAL_USERNAME", "token-user");
    vi.stubEnv("MAVEN_CENTRAL_PASSWORD", "token-password");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { force: true, recursive: true });
  });

  it("asks the Portal to publish a deployment that passes validation", () => {
    expect(uploadUrl("workhorse-jvm-v0.9.0")).toBe(
      "https://central.sonatype.com/api/v1/publisher/upload?name=workhorse-jvm-v0.9.0&publishingType=AUTOMATIC",
    );
  });

  it("sends the user token as a bearer credential", () => {
    expect(authorizationHeader("user", "secret")).toBe(
      `Bearer ${Buffer.from("user:secret").toString("base64")}`,
    );
  });

  it("waits during validation and publishing, ends at PUBLISHED, and fails on every other state", () => {
    expect(deploymentOutcome({ deploymentState: "PENDING" })).toBe("wait");
    expect(deploymentOutcome({ deploymentState: "VALIDATING" })).toBe("wait");
    expect(deploymentOutcome({ deploymentState: "VALIDATED" })).toBe("wait");
    expect(deploymentOutcome({ deploymentState: "PUBLISHING" })).toBe("wait");
    expect(deploymentOutcome({ deploymentState: "PUBLISHED" })).toBe("done");
    expect(deploymentOutcome({ deploymentState: "FAILED" })).toBe("failed");
    expect(deploymentOutcome({ deploymentState: "DROPPED" as unknown as "FAILED" })).toBe("failed");
  });

  it("uploads the bundle, then polls until Maven Central publishes it", async () => {
    const states = [
      "PENDING",
      "VALIDATING",
      "VALIDATING",
      "VALIDATED",
      "PUBLISHING",
      "PUBLISHING",
      "PUBLISHED",
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const requests: { url: string; authorization: string | undefined }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({
        url: String(url),
        authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      if (String(url).includes("/upload?")) return new Response("deployment-1");
      return Response.json({ deploymentState: states.shift() });
    });

    await expect(
      uploadToCentral(
        bundle,
        "workhorse-jvm-v0.9.0",
        "0.9.0",
        unpublished(fetchImpl),
        async () => {},
      ),
    ).resolves.toBe("deployment-1");
    expect(requests.map((request) => request.url)).toEqual([
      uploadUrl("workhorse-jvm-v0.9.0"),
      ...Array.from(
        { length: 7 },
        () => "https://central.sonatype.com/api/v1/publisher/status?id=deployment-1",
      ),
    ]);
    expect(new Set(requests.map((request) => request.authorization))).toEqual(
      new Set([authorizationHeader("token-user", "token-password")]),
    );
    // The log names each state once, when the state changes.
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      "The Portal accepted deployment deployment-1",
      "Deployment deployment-1 is PENDING",
      "Deployment deployment-1 is VALIDATING",
      "Deployment deployment-1 is VALIDATED",
      "Deployment deployment-1 is PUBLISHING",
      "Deployment deployment-1 is PUBLISHED",
    ]);
    log.mockRestore();
  });

  it("reports the Portal's errors when validation fails, without the token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/upload?")
        ? new Response("deployment-2")
        : Response.json({ deploymentState: "FAILED", errors: { jar: ["missing signature"] } }),
    );
    const failure = uploadToCentral(
      bundle,
      "name",
      "0.9.0",
      unpublished(fetchImpl),
      async () => {},
    );

    await expect(failure).rejects.toThrow(
      'Deployment deployment-2 is FAILED: {"jar":["missing signature"]}',
    );
    await expect(failure).rejects.not.toThrow("token-password");
  });

  it("fails when publishing fails after validation, and names the deployment", async () => {
    const states = ["VALIDATED", "PUBLISHING", "FAILED"];
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/upload?")
        ? new Response("deployment-6")
        : Response.json(
            states[0] === "FAILED"
              ? { deploymentState: states.shift(), errors: { publish: ["sync failed"] } }
              : { deploymentState: states.shift() },
          ),
    );

    await expect(
      uploadToCentral(bundle, "name", "0.9.0", unpublished(fetchImpl), async () => {}),
    ).rejects.toThrow('Deployment deployment-6 is FAILED: {"publish":["sync failed"]}');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("fails on a state that the Portal API does not document", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/upload?")
        ? new Response("deployment-7")
        : Response.json({ deploymentState: "DROPPED" }),
    );

    await expect(
      uploadToCentral(bundle, "name", "0.9.0", unpublished(fetchImpl), async () => {}),
    ).rejects.toThrow("Deployment deployment-7 is DROPPED: {}");
  });

  it("fails after an hour in PUBLISHING, and names the deployment and its last state", async () => {
    // A clock that the status requests and the sleeps move. Each status request takes 5 seconds.
    let clock = 0;
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/upload?")) return new Response("deployment-8");
      signals.push(init?.signal);
      clock += 5_000;
      return Response.json({ deploymentState: "PUBLISHING" });
    });
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(async (milliseconds) => {
      clock += milliseconds;
    });

    await expect(
      uploadToCentral(bundle, "name", "0.9.0", unpublished(fetchImpl), sleep, () => clock),
    ).rejects.toThrow(
      "Deployment deployment-8 did not reach PUBLISHED within 60 minutes. Its last state was PUBLISHING, and the Portal can still publish it.",
    );
    // The deadline counts the request time, so the script stops soon after the hour.
    expect(clock).toBe(60 * 60_000 + 5_000);
    // A status request every 15 seconds: 5 seconds of request and 10 seconds of sleep.
    expect(fetchImpl).toHaveBeenCalledTimes(1 + 241);
    expect(sleep).toHaveBeenCalledTimes(240);
    expect(new Set(sleep.mock.calls.map((call) => call[0]))).toEqual(new Set([10_000]));
    // Each status request has a timeout of its own.
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("retries a status request that fails for a transient reason", async () => {
    const answers: (() => Response)[] = [
      () => new Response("bad gateway", { status: 502 }),
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response("slow down", { status: 429 }),
      () => Response.json({ deploymentState: "PUBLISHED" }),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/upload?") ? new Response("deployment-3") : answers.shift()!(),
    );

    await expect(
      uploadToCentral(bundle, "name", "0.9.0", unpublished(fetchImpl), async () => {}),
    ).resolves.toBe("deployment-3");
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("fails after five status requests in a row fail, and names the deployment", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/upload?")
        ? new Response("deployment-4")
        : new Response("unavailable", { status: 503 }),
    );

    await expect(
      uploadToCentral(bundle, "name", "0.9.0", unpublished(fetchImpl), async () => {}),
    ).rejects.toThrow(
      "The Portal status request for deployment deployment-4 failed 5 times in a row: HTTP 503",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("does not retry a status request that the Portal refuses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/upload?")
        ? new Response("deployment-5")
        : new Response("unauthorized", { status: 401 }),
    );

    await expect(
      uploadToCentral(bundle, "name", "0.9.0", unpublished(fetchImpl), async () => {}),
    ).rejects.toThrow(
      "The Portal refused the status request for deployment deployment-5: HTTP 401",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("checks the same three artifacts that the release check stages", () => {
    expect(namespace).toBe(group);
    expect(artifacts).toEqual(publishedArtifacts);
    expect(publishedUrl("workhorse-kotlin", "0.10.1")).toBe(
      "https://central.sonatype.com/api/v1/publisher/published?namespace=run.workhorse&name=workhorse-kotlin&version=0.10.1",
    );
  });

  it("uploads when Maven Central has none of the artifacts, uploads nothing when it has all, and fails on some", () => {
    expect(publishedOutcome([false, false, false])).toBe("none");
    expect(publishedOutcome([true, true, true])).toBe("all");
    expect(publishedOutcome([true, false, true])).toBe("some");
  });

  it("uploads the bundle when Maven Central has none of the artifacts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = portalWith([]);

    await expect(
      uploadToCentral(bundle, "workhorse-jvm-v0.10.1", "0.10.1", fetchImpl, async () => {}),
    ).resolves.toBe("deployment-9");
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      ...artifacts.map((artifact) => publishedUrl(artifact, "0.10.1")),
      uploadUrl("workhorse-jvm-v0.10.1"),
      "https://central.sonatype.com/api/v1/publisher/status?id=deployment-9",
    ]);
    vi.restoreAllMocks();
  });

  it("uploads nothing and succeeds when a late publish gave Maven Central all the artifacts", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = portalWith(artifacts);

    await expect(
      uploadToCentral(bundle, "workhorse-jvm-v0.10.1", "0.10.1", fetchImpl, async () => {}),
    ).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual(
      artifacts.map((artifact) => publishedUrl(artifact, "0.10.1")),
    );
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      "Maven Central already has run.workhorse:workhorse:0.10.1, run.workhorse:workhorse-kotlin:0.10.1, run.workhorse:workhorse-spring-boot-starter:0.10.1. A deployment of an earlier run published them, so the upload sends nothing.",
    ]);
    log.mockRestore();
  });

  it("uploads nothing and fails when Maven Central has some of the artifacts", async () => {
    const fetchImpl = portalWith(["workhorse", "workhorse-spring-boot-starter"]);

    await expect(
      uploadToCentral(bundle, "workhorse-jvm-v0.10.1", "0.10.1", fetchImpl, async () => {}),
    ).rejects.toThrow(
      "Maven Central has run.workhorse:workhorse:0.10.1, run.workhorse:workhorse-spring-boot-starter:0.10.1 but not run.workhorse:workhorse-kotlin:0.10.1. The upload sends nothing. Read the state of each deployment of the version in the Portal.",
    );
    expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes("/upload?"))).toBe(false);
  });

  it("retries a check of Maven Central that fails for a transient reason", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const answers: (() => Response)[] = [
      () => new Response("bad gateway", { status: 502 }),
      () => {
        throw new TypeError("fetch failed");
      },
      () => Response.json({ published: true }),
      () => Response.json({ published: true }),
      () => Response.json({ published: true }),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => answers.shift()!());
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(async () => {});

    await expect(publishedComponents("0.10.1", "Bearer x", fetchImpl, sleep)).resolves.toEqual([
      true,
      true,
      true,
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("fails without an upload when the check of Maven Central keeps failing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 }));

    await expect(
      uploadToCentral(bundle, "name", "0.10.1", fetchImpl, async () => {}),
    ).rejects.toThrow(
      "The request that checks whether Maven Central has run.workhorse:workhorse:0.10.1 failed 5 times in a row: HTTP 503",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    warn.mockRestore();
  });

  it("fails without an upload when the Portal refuses the check or answers without a boolean", async () => {
    const refused = vi.fn<typeof fetch>(async () => new Response("forbidden", { status: 403 }));
    await expect(
      uploadToCentral(bundle, "name", "0.10.1", refused, async () => {}),
    ).rejects.toThrow(
      "The Portal refused the request that checks whether Maven Central has run.workhorse:workhorse:0.10.1: HTTP 403",
    );
    expect(refused).toHaveBeenCalledTimes(1);

    const unclear = vi.fn<typeof fetch>(async () => Response.json({ status: "unknown" }));
    await expect(
      uploadToCentral(bundle, "name", "0.10.1", unclear, async () => {}),
    ).rejects.toThrow(
      'The Portal refused the request that checks whether Maven Central has run.workhorse:workhorse:0.10.1: an answer without a boolean published: {"status":"unknown"}',
    );
    expect(unclear).toHaveBeenCalledTimes(1);
  });

  it("fails without an upload when a later check of Maven Central fails", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      signals.push(init?.signal);
      return new URL(String(url)).searchParams.get("name") === "workhorse-spring-boot-starter"
        ? new Response("forbidden", { status: 403 })
        : Response.json({ published: false });
    });

    await expect(
      uploadToCentral(bundle, "name", "0.10.1", fetchImpl, async () => {}),
    ).rejects.toThrow(
      "The Portal refused the request that checks whether Maven Central has run.workhorse:workhorse-spring-boot-starter:0.10.1: HTTP 403",
    );
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual(
      artifacts.map((artifact) => publishedUrl(artifact, "0.10.1")),
    );
    // Each check has a timeout of its own, so a stalled request cannot hold the job.
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("refuses to upload without the user token", async () => {
    vi.stubEnv("MAVEN_CENTRAL_PASSWORD", "");
    await expect(uploadToCentral(bundle, "name", "0.9.0", vi.fn<typeof fetch>())).rejects.toThrow(
      "The upload needs MAVEN_CENTRAL_USERNAME and MAVEN_CENTRAL_PASSWORD",
    );
  });
});
