import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { checkMainCiPlan, type Gh, readLanePlan } from "./check-main-ci-plan.js";
import {
  FULL_PUSH_LANES,
  LANE_NAMES,
  LANE_PLAN_ARTIFACT,
  LANE_PLAN_FILE,
  lanePlanRecord,
  planLanes,
  RELEASE_PUSH_LANES,
} from "./ci-lanes.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const repository = "stablemates/workhorse";
const sha = "a".repeat(40);
const other = "b".repeat(40);

/** A run of the CI workflow as the GitHub API lists it. */
function ciRun(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    run_attempt: 1,
    head_sha: sha,
    head_branch: "main",
    event: "push",
    path: ".github/workflows/ci.yml",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

/** The plan file of a push run, as the plan job writes it. */
function planFile(
  files: readonly string[] | undefined,
  { sha: commit = sha, runId = 42, runAttempt = 1 } = {},
): string {
  const { plan, reason } = planLanes("push", "", files);
  const record = lanePlanRecord({ event: "push", sha: commit, runId, runAttempt }, plan, reason);
  return `${JSON.stringify(record)}\n`;
}

/**
 * A stand-in for `gh`. `gh api` prints the runs, or fails when `runs` is `"fail"`. `gh run
 * download` writes the plan file of the run into the `--dir` directory, or fails when the run has
 * no plan.
 */
function fakeGh(runs: readonly object[] | "fail", plans: Record<number, string>) {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push([...args]);
    if (args[0] === "api") {
      if (runs === "fail") throw new Error("gh: HTTP 502");
      return JSON.stringify({ total_count: runs.length, workflow_runs: runs });
    }
    if (args[0] === "run" && args[1] === "download") {
      const id = Number(args[2]);
      const directory = args[args.indexOf("--dir") + 1] ?? "";
      const plan = plans[id];
      if (plan === undefined) throw new Error(`no artifact matches any of the names provided`);
      await writeFile(path.join(directory, LANE_PLAN_FILE), plan);
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, calls };
}

describe("the main CI plan check before a release publishes", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "workhorse-main-ci-plan-"));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  const check = (gh: Gh) => checkMainCiPlan({ repository, sha, gh, directory });

  it("passes a successful push run that planned every release lane", async () => {
    const { gh, calls } = fakeGh([ciRun(42)], { 42: planFile(["go/version.go"]) });

    const outcome = await check(gh);

    expect(outcome).toEqual({
      ok: true,
      message: `The main CI run https://github.com/${repository}/actions/runs/42 planned every release lane for ${sha}.`,
    });
    expect(calls[0]).toEqual([
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      `repos/${repository}/actions/workflows/ci.yml/runs`,
      "-f",
      `head_sha=${sha}`,
      "-f",
      "branch=main",
      "-f",
      "event=push",
      "-f",
      "status=completed",
      "-f",
      "per_page=100",
    ]);
    expect(calls[1]?.slice(0, 7)).toEqual([
      "run",
      "download",
      "42",
      "--repo",
      `github.com/${repository}`,
      "--name",
      LANE_PLAN_ARTIFACT,
    ]);
  });

  it("fails for a run that planned only some lanes and names the run and the lanes", async () => {
    const { gh } = fakeGh([ciRun(42)], { 42: planFile(["python/src/workhorse/queue.py"]) });

    const outcome = await check(gh);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(`https://github.com/${repository}/actions/runs/42`);
    expect(outcome.message).toMatch(/did not plan the lanes .*\bgo\b/);
    expect(outcome.message).toContain("rust");
    expect(outcome.message).not.toMatch(/did not plan the lanes [^.]*\bpython\b/);
  });

  /** A valid full plan of run 42 with one change to its record. */
  const changedPlan = (change: (record: Record<string, unknown>) => void) => {
    const record = JSON.parse(planFile(undefined)) as Record<string, unknown>;
    change(record);
    return JSON.stringify(record);
  };
  const changedLanes = (change: (lanes: Record<string, unknown>) => void) =>
    changedPlan((record) => change(record.lanes as Record<string, unknown>));

  it.each([
    ["the run has no plan artifact", undefined, "cannot read its lane plan: no artifact matches"],
    ["the plan is not JSON", "lanes=all\n", "its lane plan is not JSON"],
    ["the plan is a truncated file", planFile(undefined).slice(0, 40), "its lane plan is not JSON"],
    ["the plan is not an object", "null", "its lane plan is empty"],
    [
      "the plan is for another commit",
      planFile(undefined, { sha: other }),
      `its lane plan is for ${other}`,
    ],
    [
      "the plan is for another run",
      planFile(undefined, { runId: 41 }),
      "its lane plan is for the run 41",
    ],
    // A "re-run all jobs" attempt overwrote the plan after GitHub listed the earlier success.
    [
      "the plan is for a newer attempt",
      planFile(undefined, { runAttempt: 2 }),
      "its lane plan is for attempt 2, not for attempt 1 or an earlier one",
    ],
    [
      "the plan has no attempt",
      changedPlan((record) => delete record.runAttempt),
      "its lane plan is for attempt undefined",
    ],
    [
      "the plan is for another event",
      changedPlan((record) => (record.event = "pull_request")),
      "its lane plan is for a pull_request event",
    ],
    [
      "the plan has another version",
      changedPlan((record) => (record.version = 2)),
      "its lane plan has version 2, not 1",
    ],
    [
      "the plan has no lanes",
      changedPlan((record) => delete record.lanes),
      "its lane plan has no lanes",
    ],
    [
      "the plan gives its lanes as a list",
      changedPlan((record) => (record.lanes = [...RELEASE_PUSH_LANES])),
      "its lane plan has no lanes",
    ],
    [
      "the plan omits a lane",
      changedLanes((lanes) => delete lanes.static),
      "its lane plan gives no decision for static",
    ],
    [
      "a lane of the plan is not a boolean",
      changedLanes((lanes) => (lanes.static = "true")),
      "its lane plan gives no decision for static",
    ],
    [
      "the plan names a lane that this commit does not know",
      changedLanes((lanes) => (lanes.unknown = true)),
      "its lane plan names lanes that this commit does not know: unknown",
    ],
  ])("fails when %s", async (_, plan, reason) => {
    const { gh } = fakeGh([ciRun(42)], plan === undefined ? {} : { 42: plan });

    const outcome = await check(gh);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(
      `https://github.com/${repository}/actions/runs/42: ${reason}`,
    );
  });

  it("passes each changed plan only through the change, not through another field", () => {
    // The fixtures above start from this plan, so each refusal comes from the one changed field.
    expect(
      readLanePlan(
        changedPlan(() => {}),
        sha,
        { id: 42, attempt: 1 },
      ),
    ).toEqual({
      missing: [],
    });
  });

  it("fails when GitHub cannot list the runs", async () => {
    const { gh } = fakeGh("fail", {});

    const outcome = await check(gh);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("gh: HTTP 502");
  });

  it("fails when GitHub returns a body that is not a run list", async () => {
    const outcome = await check(async () => "{}");

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(sha);
  });

  it.each([
    ["a run of another commit", ciRun(42, { head_sha: other })],
    ["a canceled run", ciRun(42, { conclusion: "cancelled" })],
    ["a failed run", ciRun(42, { conclusion: "failure" })],
    ["an unfinished run", ciRun(42, { status: "in_progress", conclusion: null })],
    ["a pull request run", ciRun(42, { event: "pull_request" })],
    ["a run on another branch", ciRun(42, { head_branch: "feature" })],
    ["a run of another workflow", ciRun(42, { path: ".github/workflows/benchmark.yml" })],
    ["a run without a valid ID", ciRun(42, { id: "42; rm -rf /" })],
    ["a run without a valid attempt", ciRun(42, { run_attempt: 0 })],
  ])("fails when GitHub returns only %s", async (_, run) => {
    const { gh, calls } = fakeGh([run], { 42: planFile(undefined) });

    const outcome = await check(gh);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(`No successful main CI push run exists for ${sha}`);
    expect(calls).toHaveLength(1);
  });

  it("passes a re-run of the failed jobs, which keeps the plan of the earlier attempt", async () => {
    const { gh } = fakeGh([ciRun(42, { run_attempt: 2 })], { 42: planFile(undefined) });

    expect(await check(gh)).toMatchObject({ ok: true });
  });

  it("passes when one of several successful runs planned every release lane", async () => {
    const { gh } = fakeGh([ciRun(43), ciRun(42)], {
      43: planFile(["go/queue.go"], { runId: 43 }),
      42: planFile(undefined),
    });

    const outcome = await check(gh);

    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.message).toContain("/actions/runs/42 planned every release lane");
  });

  it("refuses a repository or a commit that is not well formed, before it asks GitHub", async () => {
    const { gh, calls } = fakeGh([ciRun(42)], { 42: planFile(undefined) });

    expect((await checkMainCiPlan({ repository: "../x", sha, gh, directory })).ok).toBe(false);
    expect((await checkMainCiPlan({ repository, sha: "HEAD", gh, directory })).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("reading a lane plan", () => {
  it("reads the plan that the plan job writes for a full push run", () => {
    expect(readLanePlan(planFile(undefined), sha, { id: 42, attempt: 1 })).toEqual({ missing: [] });
  });

  it("names each lane that a full push run runs and the plan skips", () => {
    const outcome = readLanePlan(planFile(["go/queue.go"]), sha, { id: 42, attempt: 1 });
    expect(outcome).toHaveProperty("missing");
    const missing = "missing" in outcome ? outcome.missing : [];
    expect(missing).toContain("python");
    expect(missing).not.toContain("go");
    expect(missing).not.toContain("static");
  });

  it("requires every lane that a release push runs, with the packed lane", () => {
    const { plan } = planLanes("push", "", ["go/version.go"]);
    expect(RELEASE_PUSH_LANES).toEqual(LANE_NAMES.filter((lane) => plan[lane]));
    expect(RELEASE_PUSH_LANES).toContain("packed");
    expect(RELEASE_PUSH_LANES).not.toContain("ruby-rails");
  });

  // A change to a shared input runs every push lane but not the packed lane, as the push run of a
  // commit before SM-1893 did. Such a run cannot release.
  it("names the packed lane when a push run skipped it", () => {
    const { plan } = planLanes("push", "", ["scripts/ci-lanes.ts"]);
    expect(FULL_PUSH_LANES).toEqual(LANE_NAMES.filter((lane) => plan[lane]));
    expect(readLanePlan(planFile(["scripts/ci-lanes.ts"]), sha, { id: 42, attempt: 1 })).toEqual({
      missing: ["packed"],
    });
  });
});

describe("the release workflows and ci.yml", () => {
  interface Step {
    readonly name?: string;
    readonly if?: string;
    readonly run?: string;
    readonly uses?: string;
    readonly env?: Record<string, string>;
    readonly with?: Record<string, unknown>;
  }
  interface Workflow {
    readonly permissions?: Record<string, string>;
    readonly jobs: Record<string, { readonly needs?: unknown; readonly steps: readonly Step[] }>;
  }
  const read = async (file: string) =>
    parse(await readFile(path.join(repositoryRoot, ".github/workflows", file), "utf8")) as Workflow;
  /** Tells whether a job waits for the build job, directly or through the jobs that it needs. */
  const waitsForBuild = (workflow: Workflow, name: string, seen = new Set<string>()): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    const { needs } = workflow.jobs[name] ?? {};
    const names = typeof needs === "string" ? [needs] : Array.isArray(needs) ? needs : [];
    return names.some(
      (need: unknown) =>
        need === "build" || (typeof need === "string" && waitsForBuild(workflow, need, seen)),
    );
  };

  it("finds a job that waits for no job", () => {
    const workflow: Workflow = {
      jobs: {
        build: { steps: [] },
        publish: { needs: [], steps: [] },
        verify: { needs: ["publish"], steps: [] },
        notify: { needs: "verify", steps: [] },
        release: { needs: ["build"], steps: [] },
      },
    };
    expect(["publish", "verify", "notify"].some((name) => waitsForBuild(workflow, name))).toBe(
      false,
    );
    expect(waitsForBuild(workflow, "release")).toBe(true);
  });

  const command =
    'pnpm --silent exec tsx scripts/check-main-ci-plan.ts "$GITHUB_REPOSITORY" "$GITHUB_SHA"';

  it.each(["release.yml", "release-python.yml"])(
    "%s checks the plan of the main CI run in its first job, before it builds anything",
    async (file) => {
      const workflow = await read(file);
      expect(workflow.permissions?.actions).toBe("read");
      const build = workflow.jobs.build;
      expect(build?.needs).toBeUndefined();
      const steps = build?.steps ?? [];
      const index = steps.findIndex((step) => step.run === command);
      expect(index).toBeGreaterThan(0);
      expect(steps[index]?.env?.GH_TOKEN).toBe("${{ github.token }}");
      expect(steps[index]?.if).toBeUndefined();
      // Only the checkout, the tool setup, and the install run before the check.
      for (const step of steps.slice(0, index))
        expect(
          step.uses !== undefined ||
            step.run === "pnpm install --frozen-lockfile" ||
            step.name === "Install matching PostgreSQL client",
        ).toBe(true);
      // Every other job waits for the build job, directly or through another job.
      expect(Object.keys(workflow.jobs).filter((name) => !waitsForBuild(workflow, name))).toEqual([
        "build",
      ]);
      // The old check, which accepted any successful run, is gone.
      expect(JSON.stringify(workflow)).not.toContain('select(.conclusion == \\"success\\")');
    },
  );

  it("publishes the plan of each push run as an artifact", async () => {
    const workflow = await read("ci.yml");
    const steps = workflow.jobs.plan?.steps ?? [];
    const lanes = steps.find((step) => step.run?.includes("scripts/ci-lanes.ts"));
    expect(lanes?.env?.LANE_PLAN_PATH).toBe(`\${{ runner.temp }}/${LANE_PLAN_FILE}`);
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.if).toBe("github.event_name == 'push'");
    expect(upload?.with).toMatchObject({
      name: LANE_PLAN_ARTIFACT,
      path: `\${{ runner.temp }}/${LANE_PLAN_FILE}`,
      "if-no-files-found": "error",
    });
  });
});
