import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
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

/**
 * Stand-ins for `gh` and `pnpm` that come first on `PATH`, so the script reaches no GitHub API and
 * runs no check. Each one appends its arguments to a log. The `gh` stand-in prints the lines of
 * `runs` as `gh api --jq` prints them, or exits 1 when `runs` is `"fail"`. The `pnpm` stand-in
 * fails the main CI plan check when `plan` is `"partial"`, as scripts/check-main-ci-plan.ts fails
 * for a run that skipped lanes or a plan that it cannot read.
 */
async function stubTools(
  runs: string[] | "fail",
  plan: "full" | "partial" = "full",
): Promise<{
  env: NodeJS.ProcessEnv;
  calls: () => Promise<{ gh: string[]; pnpm: string[] }>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "workhorse-release-go-tools-"));
  temporaryDirectories.push(directory);
  const ghLog = join(directory, "gh.log");
  const pnpmLog = join(directory, "pnpm.log");
  const runsFile = join(directory, "runs.tsv");
  await writeFile(runsFile, runs === "fail" ? "" : runs.map((line) => `${line}\n`).join(""));
  const ghBody =
    runs === "fail" ? 'echo "gh: HTTP 502" >&2\nexit 1\n' : `cat ${JSON.stringify(runsFile)}\n`;
  await writeFile(
    join(directory, "gh"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}\n${ghBody}`,
  );
  const planCheck =
    plan === "partial"
      ? 'case "$*" in *check-main-ci-plan.ts*) echo "did not plan the lanes go" >&2; exit 1 ;; esac\n'
      : "";
  await writeFile(
    join(directory, "pnpm"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(pnpmLog)}\n${planCheck}`,
  );
  await chmod(join(directory, "gh"), 0o755);
  await chmod(join(directory, "pnpm"), 0o755);
  return {
    env: { ...gitEnvironment, PATH: `${directory}:${process.env.PATH ?? ""}` },
    calls: async () => ({ gh: await logLines(ghLog), pnpm: await logLines(pnpmLog) }),
  };
}

async function logLines(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "");
}

/** One line of `gh api --jq` output for a run of the CI workflow. */
function ciRun(
  commit: string,
  conclusion: string,
  {
    branch = "main",
    event = "push",
    id = 7,
    repository = "stablemates/workhorse",
  }: { branch?: string; event?: string; id?: number; repository?: string } = {},
): string {
  return [
    commit,
    branch,
    event,
    ".github/workflows/ci.yml",
    "completed",
    conclusion,
    `https://github.com/${repository}/actions/runs/${id}`,
  ].join("\t");
}

/** The `pnpm` arguments with which the script runs the main CI plan check for the candidate. */
const planCheck = (candidate: string) =>
  `--silent exec tsx scripts/check-main-ci-plan.ts stablemates/workhorse ${candidate}`;

const githubOrigin = "https://github.com/stablemates/workhorse.git";
const forkOrigin = "https://github.com/someone/workhorse.git";

/**
 * A scratch release whose npm and Python tags on origin point to the candidate. Its origin URL names
 * a GitHub repository, and `url.<path>.insteadOf` sends every fetch and push to the scratch origin.
 */
async function gateCandidate(): Promise<{ checkout: string; candidate: string }> {
  const scratch = await scratchRelease();
  await pushTag(scratch.checkout, "v1.2.3", scratch.candidate);
  await pushTag(scratch.checkout, "python/v1.2.3", scratch.candidate);
  const origin = await git(scratch.checkout, "config", "--get", "remote.origin.url");
  await git(scratch.checkout, "config", `url.${origin}.insteadOf`, githubOrigin);
  await git(scratch.checkout, "remote", "set-url", "origin", githubOrigin);
  return scratch;
}

async function releaseGo(
  checkout: string,
  version: string,
  env: NodeJS.ProcessEnv = gitEnvironment,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      "sh",
      ["scripts/release-go.sh", version],
      { cwd: checkout, env },
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

  describe("release gate", () => {
    const fullCheck = ["go:release-check 1.2.3", "db:reset:test", "db:reset:test-packed", "check"];
    const goChecks = ["go:release-check 1.2.3", "db:reset:test", "go:test", "go:vuln"];

    it("reuses a successful main CI push run of HEAD that planned every lane and runs only the Go checks", async () => {
      const { checkout, candidate } = await gateCandidate();
      const tools = await stubTools([ciRun(candidate, "success", { id: 42 })]);

      const result = await releaseGo(checkout, "1.2.3", tools.env);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(
        `HEAD ${candidate} passed a main CI run that planned every lane. Running only the Go checks.`,
      );
      const calls = await tools.calls();
      expect(calls.pnpm).toEqual([goChecks[0], planCheck(candidate), ...goChecks.slice(1)]);
      expect(calls.gh).toHaveLength(1);
      expect(calls.gh[0]).toContain(
        "api --hostname github.com --method GET repos/stablemates/workhorse/actions/workflows/ci.yml/runs",
      );
      expect(calls.gh[0]).toContain(`head_sha=${candidate}`);
      expect(await git(checkout, "ls-remote", "origin", "refs/tags/go/v1.2.3")).not.toBe("");
    });

    it("runs the full check when the successful run of HEAD did not plan every lane", async () => {
      const { checkout, candidate } = await gateCandidate();
      const tools = await stubTools([ciRun(candidate, "success", { id: 42 })], "partial");

      const result = await releaseGo(checkout, "1.2.3", tools.env);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("did not plan the lanes go");
      expect(result.output).toContain(
        `No main CI run that planned every lane for HEAD ${candidate}. Running the full pnpm check.`,
      );
      expect((await tools.calls()).pnpm).toEqual([
        fullCheck[0],
        planCheck(candidate),
        ...fullCheck.slice(1),
      ]);
      expect(await git(checkout, "ls-remote", "origin", "refs/tags/go/v1.2.3")).not.toBe("");
    });

    it("runs the full check when GitHub has no CI run for HEAD", async () => {
      const { checkout, candidate } = await gateCandidate();
      const tools = await stubTools([]);

      const result = await releaseGo(checkout, "1.2.3", tools.env);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(
        `No successful main CI run for HEAD ${candidate}. Running the full pnpm check.`,
      );
      expect((await tools.calls()).pnpm).toEqual(fullCheck);
    });

    it.each([
      ["a successful run of another commit", (other: string) => ciRun(other, "success")],
      ["a canceled run of HEAD", (_: string, head: string) => ciRun(head, "cancelled")],
      ["a failed run of HEAD", (_: string, head: string) => ciRun(head, "failure")],
      [
        "a successful pull request run of HEAD",
        (_: string, head: string) => ciRun(head, "success", { event: "pull_request" }),
      ],
      [
        "a successful run of HEAD on another branch",
        (_: string, head: string) => ciRun(head, "success", { branch: "feature" }),
      ],
      [
        "a successful run of HEAD in another repository",
        (_: string, head: string) => ciRun(head, "success", { repository: "someone/workhorse" }),
      ],
    ])("runs the full check when GitHub returns only %s", async (_, line) => {
      const { checkout, candidate } = await gateCandidate();
      const later = await git(checkout, "rev-parse", "origin/main");
      const tools = await stubTools([line(later, candidate)]);

      const result = await releaseGo(checkout, "1.2.3", tools.env);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(`No successful main CI run for HEAD ${candidate}.`);
      expect((await tools.calls()).pnpm).toEqual(fullCheck);
    });

    it("runs the full check when gh fails", async () => {
      const { checkout, candidate } = await gateCandidate();
      const tools = await stubTools("fail");

      const result = await releaseGo(checkout, "1.2.3", tools.env);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(`No successful main CI run for HEAD ${candidate}.`);
      const calls = await tools.calls();
      expect(calls.gh).toHaveLength(1);
      expect(calls.pnpm).toEqual(fullCheck);
    });

    it("asks about the repository of origin, not the one that GH_REPO names", async () => {
      const { checkout } = await gateCandidate();
      const tools = await stubTools([]);

      await releaseGo(checkout, "1.2.3", { ...tools.env, GH_REPO: "someone/workhorse" });

      const calls = await tools.calls();
      expect(calls.gh).toHaveLength(1);
      expect(calls.gh[0]).toContain(" repos/stablemates/workhorse/actions/");
    });

    it.each([
      ["origin is not a GitHub URL", async () => {}],
      [
        "origin pushes to another URL",
        async (checkout: string, origin: string) => {
          // Both URLs reach the scratch origin, so the tag push reaches no network.
          await git(checkout, "config", "--add", `url.${origin}.insteadOf`, forkOrigin);
          await git(checkout, "remote", "set-url", "origin", githubOrigin);
          await git(checkout, "remote", "set-url", "--push", "origin", forkOrigin);
        },
      ],
      [
        "origin has a second URL",
        async (checkout: string, origin: string) => {
          await git(checkout, "config", "--add", `url.${origin}.insteadOf`, forkOrigin);
          await git(checkout, "remote", "set-url", "origin", githubOrigin);
          await git(checkout, "config", "--add", "remote.origin.url", forkOrigin);
        },
      ],
      [
        "origin has a second push URL",
        async (checkout: string, origin: string) => {
          await git(checkout, "config", "--add", `url.${origin}.insteadOf`, forkOrigin);
          await git(checkout, "remote", "set-url", "origin", githubOrigin);
          await git(checkout, "config", "--add", "remote.origin.pushurl", forkOrigin);
          await git(checkout, "config", "--add", "remote.origin.pushurl", githubOrigin);
        },
      ],
    ])("runs the full check without asking GitHub when %s", async (_, configure) => {
      const { checkout, candidate } = await scratchRelease();
      await pushTag(checkout, "v1.2.3", candidate);
      await pushTag(checkout, "python/v1.2.3", candidate);
      const origin = await git(checkout, "config", "--get", "remote.origin.url");
      await git(checkout, "config", `url.${origin}.insteadOf`, githubOrigin);
      await configure(checkout, origin);
      const tools = await stubTools([ciRun(candidate, "success")]);

      const result = await releaseGo(checkout, "1.2.3", tools.env);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(`No successful main CI run for HEAD ${candidate}.`);
      const calls = await tools.calls();
      expect(calls.gh).toEqual([]);
      expect(calls.pnpm).toEqual(fullCheck);
    });

    it("keeps the refusals before it reads CI", async () => {
      const { checkout, candidate } = await gateCandidate();
      await pushTag(checkout, "go/v1.2.3", candidate);
      const tools = await stubTools([ciRun(candidate, "success")]);

      const result = await releaseGo(checkout, "1.2.3", tools.env);

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("go/v1.2.3 already exists on origin");
      expect(await tools.calls()).toEqual({ gh: [], pnpm: [] });
    });
  });

  it("refuses a version that has no PEP 440 spelling", async () => {
    const { checkout } = await scratchRelease();

    const result = await releaseGo(checkout, "1.2.3-preview");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("1.2.3-preview has no PEP 440 spelling");
  });
});
