import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkRegistryVersion,
  registries,
  runCheck,
  versionUrl,
} from "./check-registry-version.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The body that each registry returns for a published version with `checksum`. */
const publishedBody = {
  "crates-io": (checksum: string) => ({
    version: { crate: "workhorse", num: "0.11.0", checksum, yanked: false },
  }),
  rubygems: (checksum: string) => ({ number: "0.11.0", platform: "ruby", sha: checksum }),
} as const;

const noDelay = async () => {};

const names = { "crates-io": "workhorse", rubygems: "stablemates-workhorse" } as const;

describe("the registry version check before a crate or gem upload", () => {
  let directory: string;
  let artifact: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "workhorse-registry-check-"));
    artifact = path.join(directory, "artifact");
    await writeFile(artifact, "built bytes");
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it("asks each registry for the exact version", () => {
    expect(versionUrl("crates-io", "workhorse", "0.11.0")).toBe(
      "https://crates.io/api/v1/crates/workhorse/0.11.0",
    );
    expect(versionUrl("rubygems", "stablemates-workhorse", "0.11.0")).toBe(
      "https://rubygems.org/api/v2/rubygems/stablemates-workhorse/versions/0.11.0.json?platform=ruby",
    );
  });

  describe.each(registries)("on %s", (registry) => {
    const name = names[registry];
    const check = (fetchImpl: typeof fetch) =>
      checkRegistryVersion({
        registry,
        name,
        version: "0.11.0",
        artifact,
        fetch: fetchImpl,
        delay: noDelay,
      });

    it("uploads when the registry does not serve the version", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response("not found", { status: 404 }));
      const outcome = await check(fetchImpl);
      expect(outcome.upload).toBe(true);
      expect(outcome.message).toContain("does not serve");
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(String(url)).toBe(versionUrl(registry, name, "0.11.0"));
      // crates.io refuses an API request without a User-Agent.
      expect(new Headers(init?.headers).get("User-Agent")).toMatch(/workhorse/);
    });

    it("skips the upload when the registry serves the version with the same checksum", async () => {
      const outcome = await check(async () =>
        Response.json(publishedBody[registry](sha256("built bytes"))),
      );
      expect(outcome.upload).toBe(false);
      expect(outcome.message).toContain(`already serves ${name} 0.11.0`);
      expect(outcome.message).toContain(sha256("built bytes"));
    });

    it("fails when the registry serves the version with a different checksum", async () => {
      const other = sha256("other bytes");
      await expect(
        check(async () => Response.json(publishedBody[registry](other))),
      ).rejects.toThrow(
        new RegExp(
          `already serves ${name} 0\\.11\\.0 with SHA-256 ${other}, but .+ has SHA-256 ${sha256("built bytes")}`,
        ),
      );
    });

    it("repeats a request that fails for a transient reason", async () => {
      const answers = [
        () => Promise.reject(new TypeError("fetch failed")),
        () => Promise.resolve(new Response("busy", { status: 503 })),
        () => Promise.resolve(new Response("slow down", { status: 429 })),
        () => Promise.resolve(new Response("not found", { status: 404 })),
      ];
      const fetchImpl = vi.fn<typeof fetch>(() => answers.shift()!());
      expect((await check(fetchImpl)).upload).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    it("fails after five transient failures in a row", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response("busy", { status: 502 }));
      await expect(check(fetchImpl)).rejects.toThrow(/HTTP 502/);
      expect(fetchImpl).toHaveBeenCalledTimes(5);
    });

    it("fails at once on a refusal that does not change", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response("no", { status: 403 }));
      await expect(check(fetchImpl)).rejects.toThrow(/HTTP 403/);
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it("fails on an answer without a checksum", async () => {
      await expect(check(async () => Response.json({ unexpected: true }))).rejects.toThrow(
        /without a SHA-256 checksum/,
      );
    });
  });

  it("fails before a request when the built artifact is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      checkRegistryVersion({
        registry: "crates-io",
        name: "workhorse",
        version: "0.11.0",
        artifact: path.join(directory, "missing.crate"),
        fetch: fetchImpl,
        delay: noDelay,
      }),
    ).rejects.toThrow(/missing\.crate/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe("the command line", () => {
    let output: string;
    let summary: string;

    beforeEach(() => {
      output = path.join(directory, "output");
      summary = path.join(directory, "summary");
    });

    const run = (fetchImpl: typeof fetch, argv = ["rubygems", "stablemates-workhorse", "0.11.0"]) =>
      runCheck([...argv, artifact], {
        environment: { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
        fetch: fetchImpl,
        delay: noDelay,
      });

    it("writes upload=true for a version that the registry does not serve", async () => {
      expect(await run(async () => new Response("", { status: 404 }))).toBe(0);
      expect(await readFile(output, "utf8")).toBe("upload=true\n");
    });

    it("writes upload=false and a summary line for a version that the registry serves", async () => {
      const body = publishedBody.rubygems(sha256("built bytes"));
      expect(await run(async () => Response.json(body))).toBe(0);
      expect(await readFile(output, "utf8")).toBe("upload=false\n");
      expect(await readFile(summary, "utf8")).toContain("already serves stablemates-workhorse");
    });

    it("writes no output and fails for a different checksum", async () => {
      const body = publishedBody.rubygems(sha256("other bytes"));
      expect(await run(async () => Response.json(body))).toBe(1);
      await expect(readFile(output, "utf8")).rejects.toThrow(/ENOENT/);
      expect(await readFile(summary, "utf8")).toContain("cannot publish these bytes");
    });

    it("refuses an unknown registry", async () => {
      expect(await run(vi.fn<typeof fetch>(), ["pypi", "workhorse", "0.11.0"])).toBe(64);
    });
  });
});
