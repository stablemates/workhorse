import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authorizationHeader,
  deploymentOutcome,
  uploadToCentral,
  uploadUrl,
} from "./upload-maven-central.js";

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
      uploadToCentral(bundle, "workhorse-jvm-v0.9.0", fetchImpl, async () => {}),
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
    const failure = uploadToCentral(bundle, "name", fetchImpl, async () => {});

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

    await expect(uploadToCentral(bundle, "name", fetchImpl, async () => {})).rejects.toThrow(
      'Deployment deployment-6 is FAILED: {"publish":["sync failed"]}',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("fails on a state that the Portal API does not document", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/upload?")
        ? new Response("deployment-7")
        : Response.json({ deploymentState: "DROPPED" }),
    );

    await expect(uploadToCentral(bundle, "name", fetchImpl, async () => {})).rejects.toThrow(
      "Deployment deployment-7 is DROPPED: {}",
    );
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

    await expect(uploadToCentral(bundle, "name", fetchImpl, sleep, () => clock)).rejects.toThrow(
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

    await expect(uploadToCentral(bundle, "name", fetchImpl, async () => {})).resolves.toBe(
      "deployment-3",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("fails after five status requests in a row fail, and names the deployment", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/upload?")
        ? new Response("deployment-4")
        : new Response("unavailable", { status: 503 }),
    );

    await expect(uploadToCentral(bundle, "name", fetchImpl, async () => {})).rejects.toThrow(
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

    await expect(uploadToCentral(bundle, "name", fetchImpl, async () => {})).rejects.toThrow(
      "The Portal refused the status request for deployment deployment-5: HTTP 401",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses to upload without the user token", async () => {
    vi.stubEnv("MAVEN_CENTRAL_PASSWORD", "");
    await expect(uploadToCentral(bundle, "name", vi.fn<typeof fetch>())).rejects.toThrow(
      "The upload needs MAVEN_CENTRAL_USERNAME and MAVEN_CENTRAL_PASSWORD",
    );
  });
});
