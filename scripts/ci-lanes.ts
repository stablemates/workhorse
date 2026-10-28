// The lane-input map of ADR 0083 ("Amended by SM-1548"). A pull request runs a lane only when it
// changes a file that the lane reads. The plan job of .github/workflows/ci.yml runs this script and
// gives each other job of the workflow one boolean output that decides whether the job runs.
//
// The static job also runs the steps of one language only when the plan selects the filtered lane
// of that language (SM-1877). Thus the inputs of a filtered lane also hold each file that the
// static steps of its language read.
//
// The map fails open. If a changed file matches a shared input, or no entry of the map names it,
// every lane runs. A docs-only pull request runs only the always-run lanes that check the
// documentation (SM-1681). A push to `main` uses the same map for the files that it changes, but it
// runs every lane if it changes a release file or if the plan cannot list its files (SM-1878). The
// release workflows require a successful push run for the tagged commit that planned every lane, so
// the release candidate commit must run every lane. The plan job uploads the plan of each push run,
// and scripts/check-main-ci-plan.ts reads it for a release (SM-1886). `workflow_dispatch` runs and the weekly schedule run every lane that
// their event runs, whatever changed. scripts/ci-lanes.test.ts holds the map to the workflow and to
// the files each lane names in its sources.
//
// `tsx scripts/ci-lanes.ts --docs-only` reads changed paths from standard input and tells whether
// the change is docs-only, for the merge rule in AGENTS.md.
import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { WEEKLY_COMPATIBILITY_SCHEDULE } from "./ci-matrix.js";

/**
 * Inputs that can change the result of every lane. A change to one of them runs every lane.
 *
 * Every lane resets its test database through the TypeScript CLI in `typescript/core` and reads
 * the shared fixtures in `typescript/core/test`, `protocol/`, and `dashboard/v1/`. The generated SQL
 * and dashboard catalogues come from `sql/` and `dashboard/v1/`, so a change to a generated file is
 * a change to their shared source.
 */
export const SHARED_INPUTS = [
  ".github/**",
  "scripts/**",
  "protocol/**",
  "sql/**",
  "dashboard/v1/**",
  "typescript/core/**",
  "api/telemetry.txt",
  // The SQL catalogues that scripts/generate-sql-catalogues.ts writes.
  "go/sql_catalogue_generated.go",
  "jvm/workhorse/src/main/java/run/workhorse/internal/SqlCatalogue.java",
  "dotnet/src/Workhorse/Internal/SqlCatalogue.g.cs",
  "dotnet/src/Workhorse.AspNetCore/Internal/DashboardSqlCatalogue.g.cs",
  "python/src/workhorse/_statements.py",
  "ruby/lib/stablemates/workhorse/sql_catalogue_generated.rb",
  "rust/src/sql_catalogue_generated.rs",
  // The dashboard catalogues that typescript/dashboard-server/spec/generate-bindings.ts writes.
  "go/dashboard/v1_generated.go",
  "jvm/workhorse/src/main/java/run/workhorse/dashboard/V1.java",
  "dotnet/src/Workhorse.AspNetCore/Internal/V1.g.cs",
  "python/src/workhorse/dashboard_v1.py",
  "ruby/lib/stablemates/workhorse/dashboard/v1_generated.rb",
  "rust/src/dashboard/v1_generated.rs",
  // The toolchain pins, the support matrix, and the root package configuration.
  "mise.toml",
  "support.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig*.json",
  "vitest*.config.ts",
] as const;

/**
 * Lanes that run on every event that the workflow runs them for. They check every language at
 * once: format, lint, generated files, API snapshots, documentation tests, and the demo and site
 * smoke tests.
 */
export const ALWAYS_RUN_LANES = ["static", "unit", "npm-release-scope", "demo"] as const;

/** Lanes that run only on `workflow_dispatch` and on the weekly schedule (ADR 0083). */
export const WEEKLY_LANES = [
  "packed",
  "ruby-rails",
  "ruby-rails-main",
  "spring-boot-snapshot",
] as const;

export interface FilteredLane {
  /**
   * Globs of the files that the lane runs. scripts/ci-lanes.test.ts requires that every repository
   * file that one of these files names by path is an input of the lane. A Vitest file that is not a
   * database test is not a source, because the always-run lanes run it.
   */
  readonly sources: readonly string[];
  /** Files that can change the result of the lane, in addition to {@link SHARED_INPUTS}. */
  readonly inputs: readonly string[];
}

// The TypeScript build. `pnpm build:runtime:dev` compiles every workspace package and the
// dashboard application, and each lane that runs it fails if the build fails.
const typescriptBuild = ["typescript/**", "dashboard/**"];

const javaInputs = ["jvm/**", "api/java.txt", "api/kotlin.txt"];
const jvmResolutionInputs = [
  "jvm/**/*.gradle.kts",
  "jvm/gradle/**",
  "jvm/gradle.properties",
  "jvm/release-consumer/**",
];
const rubyInputs = ["ruby/**", "api/ruby.txt"];

/** Lanes that a pull request runs only when it changes one of their inputs. */
export const FILTERED_LANES = {
  typescript: {
    // The lane runs the database test files of vitest.config.ts. The unit tests run in the unit and
    // npm-release-scope lanes, so scripts/ci-lanes.test.ts skips them.
    sources: [
      "scripts/*-integration.test.ts",
      "scripts/pooling-fixture.ts",
      "typescript/**",
      "dashboard/**",
    ],
    inputs: [
      ...typescriptBuild,
      "api/typescript.txt",
      "api/cli.txt",
      // The dashboard server tests build and drive the Go dashboard conformance host.
      "go/**",
      // The landing snippet tests run each TypeScript snippet and check each retry policy.
      "site/lib/landing-snippets.ts",
      // `workhorse benchmark` names this page in its output.
      "docs/benchmarking.md",
      // database-roles-integration.test.ts runs the SQL blocks of this page.
      "docs/architecture/operations.md",
    ],
  },
  "runtime-smoke": { sources: [], inputs: typescriptBuild },
  // `pnpm test:packed` runs the full build, which also builds the site from the documentation. The
  // site build runs site/scripts/check-language-examples.ts over docs/** and site/**, so the inputs
  // stay. The lane is in WEEKLY_LANES, so a pull request never runs it.
  packed: { sources: [], inputs: [...typescriptBuild, "docs/**", "site/**"] },
  python: {
    sources: ["python/**"],
    inputs: [
      "python/**",
      ...typescriptBuild,
      "api/python.txt",
      // test_public_surface.py imports each `python` fence of the guides and the site pages.
      "docs/guides/*.md",
      "site/content/docs/*.mdx",
      // test_async_checkpoint_cancellation.py reads this page.
      "docs/architecture/schema-and-protocol.md",
    ],
  },
  go: {
    sources: ["go/**", "scripts/run-go-check.ts"],
    inputs: ["go/**", ...typescriptBuild, "api/go.txt"],
  },
  rust: {
    sources: ["rust/**", "scripts/generate-rust-conformance.ts", "scripts/generate-rust-api.ts"],
    inputs: [
      "rust/**",
      "Cargo.toml",
      "Cargo.lock",
      "rust-toolchain.toml",
      "rustfmt.toml",
      // The static lane runs `pnpm rust:vuln` only when the plan selects this lane, and cargo-deny
      // reads its configuration from this file.
      "deny.toml",
      "api/rust.txt",
      // `pnpm rust:conformance:check` holds this generated page to the Rust conformance ledger.
      "docs/rust-conformance.md",
      // worker_postgres.rs runs typescript/core/test/worker-telemetry-catalog.ts, which imports the
      // OpenTelemetry adapter.
      "typescript/otel/**",
    ],
  },
  ruby: {
    sources: ["ruby/**", "scripts/check-ruby-lockfiles.ts", "scripts/check-ruby-release.ts"],
    inputs: rubyInputs,
  },
  "ruby-rails": { sources: ["ruby/**"], inputs: rubyInputs },
  "ruby-rails-main": { sources: ["ruby/**"], inputs: rubyInputs },
  jvm: {
    sources: ["jvm/**", "scripts/check-jvm-release.ts"],
    inputs: javaInputs,
  },
  // The check writes jvm/gradle/verification-metadata.xml and the file of each release consumer
  // again, so its result depends only on the plugins and libraries that Gradle resolves. The build
  // files, the version catalogue, and the Gradle properties decide them. A change to a JVM source
  // cannot change them, and the jvm lane builds and checks the sources (SM-1877).
  "jvm-verification-metadata": {
    sources: [
      ...jvmResolutionInputs,
      "scripts/jvm-verification-metadata.ts",
      "scripts/jvm-verification-metadata/**",
    ],
    inputs: jvmResolutionInputs,
  },
  "spring-boot": { sources: ["jvm/**"], inputs: javaInputs },
  "spring-boot-snapshot": { sources: ["jvm/**"], inputs: javaInputs },
  // The exception test checks the C# exception set against Ruby's errors.rb class for class.
  dotnet: {
    sources: ["dotnet/**", "scripts/check-dotnet-release.ts"],
    inputs: ["dotnet/**", "api/dotnet.txt", "ruby/lib/stablemates/workhorse/errors.rb"],
  },
} as const satisfies Record<string, FilteredLane>;

/**
 * Files that only the lanes in {@link ALWAYS_RUN_LANES} read. A change to one of them runs no
 * filtered lane, unless a filtered lane names the same file as an input.
 */
export const ALWAYS_RUN_LANE_INPUTS = [
  "docs/**",
  "site/**",
  "api/README.md",
  "benchmarks/**",
  "ops/**",
  "*.md",
  "LICENSE",
  "NOTICE",
  // Configuration that only the static lane reads.
  ".oxfmtrc.json",
  ".oxlintrc.json",
  "knip.json",
  "lefthook.yml",
] as const;

/**
 * Files that a release candidate commit changes. A push to `main` that changes one of them runs
 * every lane, because the release workflows accept the tagged commit only after a successful push
 * run of this workflow that planned every lane (SM-1878, SM-1886). The globs hold each file that
 * scripts/check-release.ts reads for the release version or the frozen schema, each changelog, and
 * each release workflow. Each release candidate changes every changelog, so a candidate always
 * matches this list.
 */
export const RELEASE_FILES = [
  "**/CHANGELOG.md",
  // The npm manifests and their peer ranges, and the dashboard application manifest.
  "**/package.json",
  "typescript/core/src/version.ts",
  "support.json",
  "python/pyproject.toml",
  "python/src/workhorse/_version.py",
  "python/uv.lock",
  "go/version.go",
  "rust/Cargo.toml",
  "Cargo.lock",
  "jvm/gradle.properties",
  "dotnet/Directory.Build.props",
  "ruby/lib/stablemates/workhorse/version.rb",
  "ruby/Gemfile.lock",
  "ruby/gemfiles/*.lock",
  // The frozen clean-install schema of each release.
  "sql/releases/**",
  ".github/workflows/release*.yml",
] as const;

/**
 * The documentation. If every file that a pull request changes matches one of these globs, the
 * change is docs-only. Each glob is also in {@link ALWAYS_RUN_LANE_INPUTS}, so a docs-only change
 * never runs every lane. AGENTS.md lets the squash merge of a docs-only change skip its push run.
 */
export const DOC_PATHS = ["docs/**", "site/**", "*.md", "api/README.md"] as const;

/**
 * The always-run lanes that a docs-only pull request runs, because each one has a check that reads
 * the documentation:
 *
 * - `static`: oxfmt, oxlint, and knip over `site/` (parts of `pnpm format:check` and `pnpm lint`),
 *   and `pnpm typecheck` (the site and its MDX pages).
 * - `npm-release-scope`: the documentation tests of the unit scope, such as
 *   scripts/guide-reference-values.test.ts and typescript/core/test/site-guide-coverage.test.ts.
 * - `demo`: `pnpm build`, whose site build runs site/scripts/check-language-examples.ts, and the
 *   site smoke test.
 *
 * The other always-run lane, `unit`, runs only the unit tests that spawn the Python toolchain. None
 * of them reads the documentation, so a docs-only pull request skips it. A filtered lane that names
 * a changed file as an input still runs.
 */
export const DOC_CHECK_LANES = ["static", "npm-release-scope", "demo"] as const;

/** Tells whether a change lists files and every file is documentation. */
export function isDocsOnlyChange(changedFiles: readonly string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every((file) => matchesAny(file, DOC_PATHS));
}

export type FilteredLaneName = keyof typeof FILTERED_LANES;
export type LaneName = FilteredLaneName | (typeof ALWAYS_RUN_LANES)[number];
export type LanePlan = Record<LaneName, boolean>;

export const FILTERED_LANE_NAMES = Object.keys(FILTERED_LANES) as FilteredLaneName[];
export const LANE_NAMES: readonly LaneName[] = [...ALWAYS_RUN_LANES, ...FILTERED_LANE_NAMES];

/**
 * The lanes that a push to `main` runs when it runs every lane. The release workflows accept the
 * tagged commit only after a successful push run that planned each of these lanes (SM-1886).
 */
export const FULL_PUSH_LANES: readonly LaneName[] = LANE_NAMES.filter(
  (lane) => !(WEEKLY_LANES as readonly string[]).includes(lane),
);

/**
 * The artifact that the plan job of a push run uploads, and the file in it. The file holds the
 * plan that the run used. scripts/check-main-ci-plan.ts reads it for each release.
 */
export const LANE_PLAN_ARTIFACT = "lane-plan";
export const LANE_PLAN_FILE = "lane-plan.json";

/**
 * The content of {@link LANE_PLAN_FILE}. Change `version` when the shape changes. `runId` and
 * `runAttempt` name the workflow run and the attempt whose plan job wrote the file.
 */
export interface LanePlanRecord {
  readonly version: 1;
  readonly event: string;
  readonly sha: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly reason: string;
  readonly lanes: LanePlan;
}

export function lanePlanRecord(
  run: Pick<LanePlanRecord, "event" | "sha" | "runId" | "runAttempt">,
  lanes: LanePlan,
  reason: string,
): LanePlanRecord {
  return { version: 1, ...run, reason, lanes };
}

const globCache = new Map<string, RegExp>();

/**
 * Tests a repository-relative path against a glob. `**` matches any number of directories, `*`
 * matches within one path segment, and a pattern without a slash matches at the root only.
 */
export function matchesGlob(file: string, glob: string): boolean {
  let expression = globCache.get(glob);
  if (!expression) {
    let source = "";
    for (let index = 0; index < glob.length; index += 1) {
      const character = glob[index];
      if (glob.startsWith("**/", index)) {
        source += "(?:.*/)?";
        index += 2;
      } else if (glob.startsWith("**", index)) {
        source += ".*";
        index += 1;
      } else if (character === "*") source += "[^/]*";
      else if (character === "?") source += "[^/]";
      else source += (character ?? "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    expression = new RegExp(`^${source}$`);
    globCache.set(glob, expression);
  }
  return expression.test(file);
}

function matchesAny(file: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(file, glob));
}

export type LaneSelection =
  | { readonly all: true; readonly reason: string }
  | { readonly all: false; readonly lanes: ReadonlySet<FilteredLaneName> };

/** Selects the filtered lanes that a pull request with these changed files must run. */
export function selectLanes(changedFiles: readonly string[]): LaneSelection {
  if (changedFiles.length === 0) return { all: true, reason: "the change lists no files" };
  const lanes = new Set<FilteredLaneName>();
  for (const file of changedFiles) {
    if (matchesAny(file, SHARED_INPUTS)) return { all: true, reason: `${file} is a shared input` };
    let named = matchesAny(file, ALWAYS_RUN_LANE_INPUTS);
    for (const lane of FILTERED_LANE_NAMES) {
      if (matchesAny(file, FILTERED_LANES[lane].inputs)) {
        lanes.add(lane);
        named = true;
      }
    }
    if (!named) return { all: true, reason: `the lane-input map does not name ${file}` };
  }
  return { all: false, lanes };
}

/**
 * Selects the filtered lanes that a push to `main` with these changed files must run. A release
 * file runs every lane. Other files use the map, as for a pull request.
 */
export function selectPushLanes(changedFiles: readonly string[]): LaneSelection {
  const release = changedFiles.find((file) => matchesAny(file, RELEASE_FILES));
  if (release !== undefined) return { all: true, reason: `${release} is a release file` };
  return selectLanes(changedFiles);
}

/**
 * Decides which lanes run. `changedFiles` is undefined when the event is not a pull request or a
 * push, or when the plan could not list the changed files; then every lane that the event runs
 * runs.
 */
export function planLanes(
  eventName: string,
  schedule: string,
  changedFiles: readonly string[] | undefined,
): { readonly plan: LanePlan; readonly reason: string } {
  const weekly = eventName === "schedule" && schedule === WEEKLY_COMPATIBILITY_SCHEDULE;
  // The workflow has only the weekly schedule. A schedule it does not know runs nothing.
  const eventRuns = eventName !== "schedule" || weekly;
  const eventRunsWeekly = eventName === "workflow_dispatch" || weekly;

  let selection: LaneSelection = { all: true, reason: `a ${eventName} event runs every lane` };
  if (eventName === "pull_request" || eventName === "push") {
    const select = eventName === "push" ? selectPushLanes : selectLanes;
    selection = changedFiles
      ? select(changedFiles)
      : { all: true, reason: "the plan could not list the changed files" };
  }
  const docsOnly = !selection.all && changedFiles !== undefined && isDocsOnlyChange(changedFiles);

  const plan = {} as LanePlan;
  for (const lane of LANE_NAMES) {
    const eventGate = (WEEKLY_LANES as readonly string[]).includes(lane)
      ? eventRunsWeekly
      : eventRuns;
    const alwaysRun =
      (ALWAYS_RUN_LANES as readonly string[]).includes(lane) &&
      (!docsOnly || (DOC_CHECK_LANES as readonly string[]).includes(lane));
    const selected = selection.all || alwaysRun || selection.lanes.has(lane as FilteredLaneName);
    plan[lane] = eventGate && selected;
  }
  // The reason names the filtered lanes that run, not the selected lanes that the event skips.
  const filtered =
    FILTERED_LANE_NAMES.filter((lane) => plan[lane])
      .toSorted()
      .join(", ") || "no filtered lane";
  const reason = selection.all
    ? selection.reason
    : docsOnly
      ? `the change is docs-only, so it runs ${DOC_CHECK_LANES.join(", ")} and ${filtered}`
      : `the change runs ${filtered}`;
  return { plan, reason };
}

const run = promisify(execFile);

/**
 * Lists the files that a pull request changes. On a `pull_request` event, actions/checkout checks
 * out the merge commit, and its first parent is the tip of the base branch. The diff between them
 * is the change that the merge would make. `--no-renames` lists both paths of a renamed file.
 */
async function pullRequestFiles(): Promise<readonly string[] | undefined> {
  try {
    const { stdout: parents } = await run("git", ["rev-list", "--parents", "-n", "1", "HEAD"]);
    if (parents.trim().split(/\s+/).length !== 3) {
      process.stderr.write("HEAD is not the merge commit of a pull request\n");
      return undefined;
    }
    const { stdout } = await run(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", "HEAD^1", "HEAD"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.split("\0").filter(Boolean);
  } catch (error) {
    process.stderr.write(`Could not list the changed files: ${String(error)}\n`);
    return undefined;
  }
}

/** The fields of a `push` event payload that the plan reads. */
interface PushEvent {
  readonly before?: unknown;
  readonly after?: unknown;
  readonly forced?: unknown;
  readonly created?: unknown;
}

const commitSha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Finds the commit to compare a push with. A push that is not a fast-forward of an earlier `main`
 * commit has no such commit: a new branch, a force push, or a `before` SHA that is missing or all
 * zeros. Then the result has a reason and the plan runs every lane.
 */
export function pushBase(
  event: unknown,
  head: string,
): { readonly base: string } | { readonly reason: string } {
  if (typeof event !== "object" || event === null) return { reason: "the event has no payload" };
  const { before, after, forced, created } = event as PushEvent;
  if (created !== false && created !== undefined) return { reason: "the push creates the branch" };
  if (forced !== false && forced !== undefined) return { reason: "the push is a force push" };
  if (after !== head) return { reason: `the push does not end at ${head}` };
  if (typeof before !== "string" || !commitSha.test(before) || /^0+$/.test(before))
    return { reason: "the push names no commit before it" };
  return { base: before };
}

/** Runs git with these arguments and gives its standard output. A failure rejects the promise. */
export type Git = (args: readonly string[]) => Promise<string>;

/** The number of commits of the pushed history that the plan fetches to find the `before` commit. */
const PUSH_HISTORY_DEPTH = 50;

/**
 * Lists the files that a push to `main` changes. actions/checkout fetches only two commits, so the
 * plan fetches more history of the pushed commit. The `before` commit must be an ancestor of the
 * pushed commit in that history. Then the plan compares the two trees. Any failure lists no files,
 * and then the plan runs every lane.
 */
export async function pushFiles(
  eventPath: string | undefined,
  git: Git,
): Promise<readonly string[] | undefined> {
  try {
    if (!eventPath) throw new Error("GITHUB_EVENT_PATH is not set");
    const event: unknown = JSON.parse(await readFile(eventPath, "utf8"));
    const head = (await git(["rev-parse", "HEAD"])).trim();
    const found = pushBase(event, head);
    if ("reason" in found) throw new Error(found.reason);
    await git(["fetch", "--no-tags", `--depth=${PUSH_HISTORY_DEPTH}`, "origin", head]);
    // The command fails if the commit is not an ancestor, or if the fetched history does not hold
    // it. A shallow history cannot make an ancestor of a commit that is not one.
    await git(["merge-base", "--is-ancestor", found.base, head]);
    const stdout = await git(["diff", "--name-only", "--no-renames", "-z", found.base, head]);
    return stdout.split("\0").filter(Boolean);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Could not list the changed files: ${message}\n`);
    return undefined;
  }
}

async function runGit(args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Reads changed file paths from standard input, one on each line, and tells whether the change is
 * docs-only. The exit code is 0 for a docs-only change and 1 for another change.
 */
async function checkDocsOnly(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const files = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const other = files.find((file) => !matchesAny(file, DOC_PATHS));
  if (isDocsOnlyChange(files)) process.stdout.write(`docs-only: ${files.length} files\n`);
  else {
    process.stdout.write(`not docs-only: ${other ?? "the change lists no files"}\n`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const eventName = process.argv[2];
  if (eventName === "--docs-only") return checkDocsOnly();
  if (!eventName)
    throw new Error("Usage: scripts/ci-lanes.ts <event-name> [schedule] | --docs-only");
  const schedule = process.argv[3] ?? "";
  const changedFiles =
    eventName === "pull_request"
      ? await pullRequestFiles()
      : eventName === "push"
        ? await pushFiles(process.env.GITHUB_EVENT_PATH, runGit)
        : undefined;
  const { plan, reason } = planLanes(eventName, schedule, changedFiles);

  process.stderr.write(`Lane plan: ${reason}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const rows = LANE_NAMES.map((lane) => `| ${lane} | ${plan[lane] ? "runs" : "skips"} |`);
    await appendFile(
      summary,
      ["## Lane plan", "", `${reason}.`, "", "| Lane | Plan |", "| --- | --- |", ...rows, ""].join(
        "\n",
      ),
    );
  }
  // The plan job uploads this file for a push run. If the commit or the run is unknown, the file
  // is not written, the upload finds no file, and the run fails.
  const planPath = process.env.LANE_PLAN_PATH;
  const sha = process.env.GITHUB_SHA;
  const runId = Number(process.env.GITHUB_RUN_ID);
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (planPath && sha && Number.isSafeInteger(runId) && Number.isSafeInteger(runAttempt)) {
    const record = lanePlanRecord({ event: eventName, sha, runId, runAttempt }, plan, reason);
    await writeFile(planPath, `${JSON.stringify(record)}\n`);
  }
  process.stdout.write(`lanes=${JSON.stringify(plan)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
