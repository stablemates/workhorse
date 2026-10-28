/**
 * Decide whether a release workflow can publish the tagged commit (SM-1886).
 *
 * The release workflows publish a commit only after a successful `CI` push run on `main` for that
 * commit. Since SM-1878, a push run plans only the lanes that its changed files select. A
 * successful run that skipped lanes did not check every line, so this script also requires that
 * the run planned each lane of {@link FULL_PUSH_LANES}.
 *
 * The script reads the plan that the run used: the plan job of each push run uploads the
 * {@link LANE_PLAN_ARTIFACT} artifact. The script does not compute the plan again from the
 * changed files. If GitHub cannot list the runs, or no successful run has a plan that it can read
 * and that names every lane, the script fails. The message names each run and its missing lanes.
 *
 * `scripts/release-go.sh` uses the same check before it reuses a main CI run.
 *
 * Usage: tsx scripts/check-main-ci-plan.ts <owner/repo> <commit-sha>
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  FULL_PUSH_LANES,
  LANE_NAMES,
  LANE_PLAN_ARTIFACT,
  LANE_PLAN_FILE,
  type LaneName,
} from "./ci-lanes.js";

/** Runs gh with these arguments and gives its standard output. A failure rejects the promise. */
export type Gh = (args: readonly string[]) => Promise<string>;

export interface Outcome {
  readonly ok: boolean;
  readonly message: string;
}

// Each name is a path segment of the API URL, so `.` and `..` are not names.
const repositoryPattern = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

/** The successful attempt of a run that the plan must belong to. */
export interface RunAttempt {
  readonly id: number;
  readonly attempt: number;
}

/**
 * Reads the text of a plan file. The plan must be the push plan of this commit and of this run. Its
 * attempt must not be newer than the successful attempt. A "re-run failed jobs" attempt keeps the
 * plan of an earlier attempt, but a newer plan comes from an attempt that the listed result does
 * not include. The plan must give a boolean for each lane that this commit knows and no other
 * lane. Then the result names each lane of {@link FULL_PUSH_LANES} that the plan did not run.
 * Otherwise the result gives the reason.
 */
export function readLanePlan(
  text: string,
  sha: string,
  run: RunAttempt,
): { readonly missing: readonly LaneName[] } | { readonly reason: string } {
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return { reason: "its lane plan is not JSON" };
  }
  if (typeof record !== "object" || record === null) return { reason: "its lane plan is empty" };
  const {
    version,
    event,
    sha: planned,
    runId,
    runAttempt,
    lanes,
  } = record as Record<string, unknown>;
  if (version !== 1) return { reason: `its lane plan has version ${String(version)}, not 1` };
  if (event !== "push") return { reason: `its lane plan is for a ${String(event)} event` };
  if (planned !== sha) return { reason: `its lane plan is for ${String(planned)}` };
  if (runId !== run.id) return { reason: `its lane plan is for the run ${String(runId)}` };
  if (
    typeof runAttempt !== "number" ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    runAttempt > run.attempt
  )
    return {
      reason: `its lane plan is for attempt ${String(runAttempt)}, not for attempt ${run.attempt} or an earlier one`,
    };
  if (typeof lanes !== "object" || lanes === null || Array.isArray(lanes))
    return { reason: "its lane plan has no lanes" };
  const known = new Set<string>(LANE_NAMES);
  const unknown = Object.keys(lanes).filter((lane) => !known.has(lane));
  if (unknown.length > 0)
    return {
      reason: `its lane plan names lanes that this commit does not know: ${unknown.join(", ")}`,
    };
  const values = lanes as Record<string, unknown>;
  const invalid = LANE_NAMES.filter((lane) => typeof values[lane] !== "boolean");
  if (invalid.length > 0)
    return { reason: `its lane plan gives no decision for ${invalid.join(", ")}` };
  return { missing: FULL_PUSH_LANES.filter((lane) => values[lane] !== true) };
}

const isPositiveInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

interface WorkflowRun {
  readonly id?: unknown;
  readonly run_attempt?: unknown;
  readonly head_sha?: unknown;
  readonly head_branch?: unknown;
  readonly event?: unknown;
  readonly path?: unknown;
  readonly status?: unknown;
  readonly conclusion?: unknown;
}

/**
 * Lists the IDs of the successful `CI` push runs on `main` for the commit. Each field is checked
 * here, so a loose filter on the GitHub side cannot select another run.
 */
async function successfulRuns(gh: Gh, repository: string, sha: string): Promise<RunAttempt[]> {
  // The repository is on github.com. The host is fixed, so `GH_HOST` cannot select another one.
  const body = await gh([
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
  const { workflow_runs: runs } = JSON.parse(body) as { workflow_runs?: unknown };
  if (!Array.isArray(runs)) throw new Error("GitHub returned no list of workflow runs");
  return (runs as WorkflowRun[])
    .filter(
      (run) =>
        run.head_sha === sha &&
        run.head_branch === "main" &&
        run.event === "push" &&
        run.path === ".github/workflows/ci.yml" &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        isPositiveInteger(run.id) &&
        isPositiveInteger(run.run_attempt),
    )
    .map((run) => ({ id: run.id as number, attempt: run.run_attempt as number }));
}

/** Downloads the plan artifact of a run into a new directory and reads its plan file. */
async function downloadPlan(
  gh: Gh,
  repository: string,
  id: number,
  directory: string,
): Promise<string> {
  const target = path.join(directory, String(id));
  await mkdir(target);
  await gh([
    "run",
    "download",
    String(id),
    "--repo",
    `github.com/${repository}`,
    "--name",
    LANE_PLAN_ARTIFACT,
    "--dir",
    target,
  ]);
  return readFile(path.join(target, LANE_PLAN_FILE), "utf8");
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Checks that a successful `CI` push run on `main` for the commit planned every lane. `directory`
 * must be an empty directory that the check can write the downloaded plans to.
 */
export async function checkMainCiPlan({
  repository,
  sha,
  gh,
  directory,
}: {
  readonly repository: string;
  readonly sha: string;
  readonly gh: Gh;
  readonly directory: string;
}): Promise<Outcome> {
  if (!repositoryPattern.test(repository))
    return { ok: false, message: `${repository} is not an owner/repo name.` };
  if (!shaPattern.test(sha)) return { ok: false, message: `${sha} is not a commit SHA.` };

  let runs: RunAttempt[];
  try {
    runs = await successfulRuns(gh, repository, sha);
  } catch (error) {
    return {
      ok: false,
      message: `Cannot list the main CI push runs for ${sha}: ${errorMessage(error)}`,
    };
  }
  if (runs.length === 0)
    return { ok: false, message: `No successful main CI push run exists for ${sha}.` };

  const problems: string[] = [];
  for (const run of runs) {
    const url = `https://github.com/${repository}/actions/runs/${run.id}`;
    let text: string;
    try {
      text = await downloadPlan(gh, repository, run.id, directory);
    } catch (error) {
      problems.push(`${url}: cannot read its lane plan: ${errorMessage(error)}`);
      continue;
    }
    const plan = readLanePlan(text, sha, run);
    if ("reason" in plan) problems.push(`${url}: ${plan.reason}`);
    else if (plan.missing.length > 0)
      problems.push(`${url}: it did not plan the lanes ${plan.missing.join(", ")}`);
    else return { ok: true, message: `The main CI run ${url} planned every lane for ${sha}.` };
  }
  return {
    ok: false,
    message: [
      `No successful main CI push run for ${sha} planned every lane. A release needs a run that`,
      "planned every lane, such as the run of the release candidate commit.",
      ...problems.map((problem) => `- ${problem}.`),
    ].join("\n"),
  };
}

const run = promisify(execFile);

async function runGh(args: readonly string[]): Promise<string> {
  const { stdout } = await run("gh", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function main(): Promise<void> {
  const [repository, sha] = process.argv.slice(2);
  if (!repository || !sha) {
    process.stderr.write("Usage: tsx scripts/check-main-ci-plan.ts <owner/repo> <commit-sha>\n");
    process.exitCode = 1;
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), "workhorse-main-ci-plan-"));
  try {
    const outcome = await checkMainCiPlan({ repository, sha, gh: runGh, directory });
    if (outcome.ok) process.stdout.write(`${outcome.message}\n`);
    else {
      process.stderr.write(`${outcome.message}\n`);
      process.exitCode = 1;
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
