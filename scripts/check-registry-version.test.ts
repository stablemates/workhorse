import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  awaitRegistryVersion,
  checkRegistryVersion,
  registries,
  runCheck,
  versionUrl,
  requestBound,
  waitTimeout,
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

  // SM-2077: the `rubygems` job waits with this mode in place of the wait step of
  // `rubygems/release-gem`.
  describe.each(registries)("the wait after an upload to %s", (registry) => {
    const name = names[registry];
    /** A clock that only a delay moves, so each test controls the elapsed time. */
    let clock: number;
    let delay: ReturnType<typeof vi.fn<(milliseconds: number) => Promise<unknown>>>;

    beforeEach(() => {
      clock = 0;
      delay = vi.fn<(milliseconds: number) => Promise<unknown>>(async (milliseconds) => {
        clock += milliseconds;
      });
    });

    const wait = (fetchImpl: typeof fetch, timeout = 3_500) =>
      awaitRegistryVersion({
        registry,
        name,
        version: "0.11.0",
        artifact,
        fetch: fetchImpl,
        delay,
        now: () => clock,
        timeout,
        interval: 1_000,
      });

    it("asks again until the registry serves the pushed checksum", async () => {
      const answers = [
        () => new Response("not found", { status: 404 }),
        () => new Response("not found", { status: 404 }),
        () => Response.json(publishedBody[registry](sha256("built bytes"))),
      ];
      const fetchImpl = vi.fn<typeof fetch>(async () => answers.shift()!());
      const message = await wait(fetchImpl);
      expect(message).toContain(`serves ${name} 0.11.0 with SHA-256 ${sha256("built bytes")}`);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(delay.mock.calls).toEqual([[1_000], [1_000]]);
    });

    it("fails when the version is still missing at the deadline", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response("", { status: 404 }));
      await expect(wait(fetchImpl)).rejects.toThrow(
        new RegExp(`did not serve ${name} 0\\.11\\.0 after 4 requests in 3 s`),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(clock).toBe(3_000);
    });

    // Sol found that a count of requests let each request repeat transient failures again, so
    // the wait could outlast the job timeout.
    it("keeps transient failures inside the deadline", async () => {
      let call = 0;
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        call++ % 5 < 4 ? new Response("busy", { status: 503 }) : new Response("", { status: 404 }),
      );
      await expect(wait(fetchImpl, waitTimeout)).rejects.toThrow(/did not serve/);
      expect(clock).toBeLessThanOrEqual(waitTimeout + requestBound);
    });

    it("fails at once when the registry serves a different checksum", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        Response.json(publishedBody[registry](sha256("other bytes"))),
      );
      await expect(wait(fetchImpl)).rejects.toThrow(/cannot publish these bytes/);
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it("fails at once on a refusal that does not change", async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response("no", { status: 403 }));
      await expect(wait(fetchImpl)).rejects.toThrow(/HTTP 403/);
      expect(fetchImpl).toHaveBeenCalledOnce();
    });
  });

  it("ends the wait inside the 20-minute job timeout, with time for the build and the push", () => {
    expect(waitTimeout + requestBound).toBeLessThanOrEqual(13 * 60_000);
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

    it("with --wait, writes a summary line and no output when the registry serves the gem", async () => {
      const body = publishedBody.rubygems(sha256("built bytes"));
      const argv = ["--wait", "rubygems", "stablemates-workhorse", "0.11.0"];
      expect(await run(async () => Response.json(body), argv)).toBe(0);
      await expect(readFile(output, "utf8")).rejects.toThrow(/ENOENT/);
      expect(await readFile(summary, "utf8")).toContain("serves stablemates-workhorse 0.11.0");
    });

    it("with --wait, fails for a different checksum", async () => {
      const body = publishedBody.rubygems(sha256("other bytes"));
      const argv = ["--wait", "rubygems", "stablemates-workhorse", "0.11.0"];
      expect(await run(async () => Response.json(body), argv)).toBe(1);
      expect(await readFile(summary, "utf8")).toContain("cannot publish these bytes");
    });

    it("refuses --wait in a place other than the first argument", async () => {
      const argv = ["rubygems", "--wait", "stablemates-workhorse", "0.11.0"];
      expect(await run(vi.fn<typeof fetch>(), argv)).toBe(64);
    });
  });
});
