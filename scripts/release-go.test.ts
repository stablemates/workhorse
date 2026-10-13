import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const onPosix = process.platform !== "win32";
const temporaryDirectories: string[] = [];

// A git hook exports `GIT_DIR`, `GIT_INDEX_FILE`, and other `GIT_*` variables. If they reached the
// scratch commands, those commands would commit to this repository and push to its origin. The
// scratch repositories also ignore the user's git configuration, so signing or hooks cannot change
// what the script sees.
const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Release Test",
  GIT_AUTHOR_EMAIL: "release-test@example.com",
  GIT_COMMITTER_NAME: "Release Test",
  GIT_COMMITTER_EMAIL: "release-test@example.com",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, env: gitEnvironment });
  return stdout.trim();
}

/**
 * A bare origin and a clone of it. The clone holds `scripts/release-go.sh` and the commits
 * `candidate` and `later`, and origin's `main` points to `later`.
 */
async function scratchRelease(): Promise<{ checkout: string; candidate: string }> {
  const root = await mkdtemp(join(tmpdir(), "workhorse-release-go-"));
  temporaryDirectories.push(root);
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  await git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", "--quiet", origin, checkout);
  expect(await git(checkout, "rev-parse", "--show-toplevel")).toBe(await realpath(checkout));
  await mkdir(join(checkout, "scripts"));
  await copyFile(
    join(repositoryRoot, "scripts", "release-go.sh"),
    join(checkout, "scripts", "release-go.sh"),
  );
  await git(checkout, "add", ".");
  await git(checkout, "commit", "--quiet", "--message", "candidate");
  const candidate = await git(checkout, "rev-parse", "HEAD");
  await git(checkout, "commit", "--quiet", "--allow-empty", "--message", "later");
  await git(checkout, "push", "--quiet", "origin", "main");
  await git(checkout, "checkout", "--quiet", "--detach", candidate);
  return { checkout, candidate };
}

async function pushTag(checkout: string, tag: string, commit: string, annotated = true) {
  const options = annotated ? ["--annotate", "--message", tag] : [];
  await git(checkout, "tag", ...options, tag, commit);
  await git(checkout, "push", "--quiet", "origin", `refs/tags/${tag}`);
  await git(checkout, "tag", "--delete", tag);
}

async function releaseGo(
  checkout: string,
  version: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      "sh",
      ["scripts/release-go.sh", version],
      { cwd: checkout, env: gitEnvironment },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? -1 : 0;
        resolvePromise({ exitCode: code, output: `${stdout}${stderr}` });
      },
    );
  });
}

describe.skipIf(!onPosix)("scripts/release-go.sh", () => {
  it("refuses a HEAD that is not on origin/main and names the commit", async () => {
    const { checkout } = await scratchRelease();
    await git(checkout, "commit", "--quiet", "--allow-empty", "--message", "off main");
    const offMain = await git(checkout, "rev-parse", "HEAD");
    await pushTag(checkout, "v1.2.3", offMain);
    await pushTag(checkout, "python/v1.2.3", offMain);

    const result = await releaseGo(checkout, "1.2.3");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`HEAD ${offMain} is not an ancestor of origin/main`);
  });

  it("refuses when origin has no npm tag for the version", async () => {
    const { checkout, candidate } = await scratchRelease();
    await pushTag(checkout, "python/v1.2.3", candidate);

    const result = await releaseGo(checkout, "1.2.3");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("v1.2.3 does not exist on origin");
  });

  it("refuses when origin has no Python tag for the version", async () => {
    const { checkout, candidate } = await scratchRelease();
    await pushTag(checkout, "v1.2.3", candidate);

    const result = await releaseGo(checkout, "1.2.3");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("python/v1.2.3 does not exist on origin");
  });

  it("refuses a train tag that points to another commit and names both commits", async () => {
    const { checkout, candidate } = await scratchRelease();
    const later = await git(checkout, "rev-parse", "origin/main");
    await pushTag(checkout, "v1.2.3", candidate);
    await pushTag(checkout, "python/v1.2.3", later);

    const result = await releaseGo(checkout, "1.2.3");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      `python/v1.2.3 on origin points to ${later}, not to HEAD ${candidate}`,
    );
  });

  it("passes the candidate guards when both tags point to HEAD, annotated or not", async () => {
    const { checkout, candidate } = await scratchRelease();
    await pushTag(checkout, "v1.2.3", candidate);
    await pushTag(checkout, "python/v1.2.3", candidate, false);
    // The next guard stops the script before any long check runs.
    await pushTag(checkout, "go/v1.2.3", candidate);

    const result = await releaseGo(checkout, "1.2.3");

    expect(result.exitCode).toBe(1);
    expect(result.output).not.toContain("Refusing to release");
    expect(result.output).toContain("go/v1.2.3 already exists on origin");
  });

  it("reads the Python tag of a prerelease in its PEP 440 spelling", async () => {
    const { checkout, candidate } = await scratchRelease();
    await pushTag(checkout, "v1.2.3-rc.1", candidate);
    await pushTag(checkout, "python/v1.2.3rc1", candidate);
    await pushTag(checkout, "go/v1.2.3-rc.1", candidate);

    const result = await releaseGo(checkout, "1.2.3-rc.1");

    expect(result.output).not.toContain("Refusing to release");
    expect(result.output).toContain("go/v1.2.3-rc.1 already exists on origin");
  });

  it("refuses when it cannot read origin", async () => {
    const { checkout } = await scratchRelease();
    await git(checkout, "remote", "set-url", "origin", join(checkout, "missing.git"));

    const result = await releaseGo(checkout, "1.2.3");

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(
      /Refusing to release HEAD [0-9a-f]{40}: cannot fetch main from origin\./,
    );
  });

  it("refuses a version that has no PEP 440 spelling", async () => {
    const { checkout } = await scratchRelease();

    const result = await releaseGo(checkout, "1.2.3-preview");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("1.2.3-preview has no PEP 440 spelling");
  });
});
