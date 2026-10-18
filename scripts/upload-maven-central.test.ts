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

  it("keeps the maintainer's Publish step with a user-managed deployment", () => {
    expect(uploadUrl("workhorse-jvm-v0.9.0")).toBe(
      "https://central.sonatype.com/api/v1/publisher/upload?name=workhorse-jvm-v0.9.0&publishingType=USER_MANAGED",
    );
  });

  it("sends the user token as a bearer credential", () => {
    expect(authorizationHeader("user", "secret")).toBe(
      `Bearer ${Buffer.from("user:secret").toString("base64")}`,
    );
  });

  it("waits during validation, ends at VALIDATED, and fails on every other state", () => {
    expect(deploymentOutcome({ deploymentState: "PENDING" })).toBe("wait");
    expect(deploymentOutcome({ deploymentState: "VALIDATING" })).toBe("wait");
    expect(deploymentOutcome({ deploymentState: "VALIDATED" })).toBe("done");
    expect(deploymentOutcome({ deploymentState: "FAILED" })).toBe("failed");
    expect(deploymentOutcome({ deploymentState: "PUBLISHED" })).toBe("failed");
  });

  it("uploads the bundle, then polls until the Portal validates it", async () => {
    const states = ["VALIDATING", "VALIDATED"];
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
      "https://central.sonatype.com/api/v1/publisher/status?id=deployment-1",
      "https://central.sonatype.com/api/v1/publisher/status?id=deployment-1",
    ]);
    expect(new Set(requests.map((request) => request.authorization))).toEqual(
      new Set([authorizationHeader("token-user", "token-password")]),
    );
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

  it("refuses to upload without the user token", async () => {
    vi.stubEnv("MAVEN_CENTRAL_PASSWORD", "");
    await expect(uploadToCentral(bundle, "name", vi.fn<typeof fetch>())).rejects.toThrow(
      "The upload needs MAVEN_CENTRAL_USERNAME and MAVEN_CENTRAL_PASSWORD",
    );
  });
});
