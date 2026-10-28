import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  ALWAYS_RUN_LANE_INPUTS,
  ALWAYS_RUN_LANES,
  DOC_CHECK_LANES,
  DOC_PATHS,
  type FilteredLaneName,
  FILTERED_LANE_NAMES,
  FILTERED_LANES,
  LANE_NAMES,
  LANE_PLAN_FILE,
  isDocsOnlyChange,
  lanePlanRecord,
  matchesGlob,
  planLanes,
  pushBase,
  pushFiles,
  RELEASE_FILES,
  SHARED_INPUTS,
  selectLanes,
  WEEKLY_LANES,
} from "./ci-lanes.js";
import { databaseTestFiles } from "../vitest.config.js";
import { pythonToolchainTestFiles } from "../vitest.npm.config.js";
import { WEEKLY_COMPATIBILITY_SCHEDULE } from "./ci-matrix.js";

const repository = path.resolve(import.meta.dirname, "..");
const trackedFiles = execFileSync("git", ["ls-files", "-z"], { cwd: repository, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const tracked = new Set(trackedFiles);

interface Step {
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
}
interface Job {
  readonly if?: string;
  readonly steps?: readonly Step[];
  readonly needs?: string | readonly string[];
  readonly "continue-on-error"?: boolean;
  readonly outputs?: Record<string, string>;
}
const workflow = parse(readFileSync(path.join(repository, ".github/workflows/ci.yml"), "utf8")) as {
  readonly jobs: Record<string, Job>;
};
const packageScripts = (
  JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;
function matchesAny(file: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(file, glob));
}

// The workspace packages by name, for imports such as `@stablemates/workhorse-otel`.
const workspacePackages = new Map(
  trackedFiles
    .filter((file) => /^typescript\/[^/]+\/package\.json$/.test(file))
    .map((file) => {
      const { name } = JSON.parse(readFileSync(path.join(repository, file), "utf8")) as {
        name: string;
      };
      return [name, path.dirname(file)];
    }),
);

// The tracked modules that an import names. A package subpath can map to another file through the
// `exports` of its package.json, so an unresolved subpath counts as every module of the package.
function resolveImport(from: string, specifier: string): readonly string[] {
  let base: string;
  let packageDirectory: string | undefined;
  if (specifier.startsWith(".")) base = path.posix.join(path.posix.dirname(from), specifier);
  else {
    const name = /^(@[^/]+\/[^/]+|[^/]+)/.exec(specifier)?.[1] ?? "";
    packageDirectory = workspacePackages.get(name);
    if (!packageDirectory) return [];
    base = path.posix.join(packageDirectory, "src", specifier.slice(name.length));
  }
  const stem = base.replace(/\.[cm]?js$/, "");
  const file = [`${stem}.ts`, `${stem}.mts`, base, `${base}/index.ts`].find((candidate) =>
    tracked.has(candidate),
  );
  if (file) return [file];
  if (!packageDirectory) return [];
  const sourceDirectory = `${packageDirectory}/src/`;
  return trackedFiles.filter((candidate) => candidate.startsWith(sourceDirectory));
}

/** The TypeScript file and every tracked module that it imports, directly or through others. */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(path.join(repository, file), "utf8");
    for (const [, specifier = ""] of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      pending.push(...resolveImport(file, specifier));
    }
  }
  return seen;
}

function unitTest(file: string): boolean {
  return /\.test\.[cm]?ts$/.test(file) && !matchesAny(file, databaseTestFiles);
}

const gateJobs = new Set(["plan", "required", "notify"]);
const laneJobs = Object.keys(workflow.jobs).filter((job) => !gateJobs.has(job));

function needsOf(job: Job): readonly string[] {
  if (job.needs === undefined) return [];
  return typeof job.needs === "string" ? [job.needs] : job.needs;
}

describe("the lane-input map and ci.yml", () => {
  it("has one entry for each lane of the workflow", () => {
    expect([...LANE_NAMES].toSorted()).toEqual([...laneJobs].toSorted());
  });

  it("gives the plan output to the workflow", () => {
    expect(workflow.jobs.plan?.outputs?.lanes).toBe("${{ steps.lanes.outputs.lanes }}");
  });

  it.each(laneJobs)("runs %s only when the plan selects it", (name) => {
    const job = workflow.jobs[name] as Job;
    expect(needsOf(job)).toContain("plan");
    expect(job.if).toBe(`fromJSON(needs.plan.outputs.lanes)['${name}']`);
  });

  it("gates the merge on every lane that can block it", () => {
    const blocking = laneJobs.filter((job) => workflow.jobs[job]?.["continue-on-error"] !== true);
    expect([...needsOf(workflow.jobs.required as Job)].toSorted()).toEqual(
      ["plan", ...blocking].toSorted(),
    );
  });

  it("reports a failed schedule for every lane that can block a merge", () => {
    const notify = needsOf(workflow.jobs.notify as Job);
    for (const job of needsOf(workflow.jobs.required as Job)) expect(notify).toContain(job);
  });
});

describe("the lane-input map and the repository", () => {
  const globs = [
    ...SHARED_INPUTS,
    ...ALWAYS_RUN_LANE_INPUTS,
    ...FILTERED_LANE_NAMES.flatMap((lane) => FILTERED_LANES[lane].inputs),
  ];

  it.each([...new Set(globs)])("names at least one tracked file with %s", (glob) => {
    expect(trackedFiles.some((file) => matchesGlob(file, glob))).toBe(true);
  });

  it("maps each tracked file to a lane or runs every lane for it", () => {
    const skipped = trackedFiles.filter(
      (file) => !globs.some((glob) => matchesGlob(file, glob)) && !selectLanes([file]).all,
    );
    expect(skipped).toEqual([]);
  });

  it("names each tracked file in a source directory", () => {
    const sourceDirectories = [
      "dashboard/",
      "docs/",
      "dotnet/",
      "go/",
      "jvm/",
      "python/",
      "ruby/",
      "rust/",
    ];
    const unnamed = trackedFiles.filter(
      (file) =>
        (sourceDirectories.some((directory) => file.startsWith(directory)) ||
          file.startsWith("site/") ||
          file.startsWith("typescript/")) &&
        !globs.some((glob) => matchesGlob(file, glob)),
    );
    expect(unnamed).toEqual([]);
  });

  // A lane can read a file outside its own directory: a fixture, a peer program, or a page that a
  // test checks. Each such path that a source file of the lane names must be an input of the lane.
  // Comment lines do not read files, so the scan skips them.
  const reference =
    /(?:^|[^\w./-])(?:\.\.\/)*((?:api|benchmarks|dashboard|docs|go|jvm|ops|protocol|python|ruby|rust|scripts|site|sql|typescript)\/[\w./-]*\w)/g;
  const commentLine = /^\s*(?:\/\/|\/\*|\*|#)/;
  const textFile =
    /\.(?:go|rs|rb|py|java|kt|kts|cs|csproj|props|ts|mts|js|mjs|json|toml|ya?ml|gemspec|sh)$/;

  // Paths that a source names in prose, such as a Python docstring, without reading the file.
  // The api-snapshot tasks write build/api/java.txt and build/api/kotlin.txt, not the committed
  // snapshots.
  const mentions = new Set([
    "jvm/api-snapshot/build.gradle.kts reads api/java.txt",
    "jvm/api-snapshot/build.gradle.kts reads api/kotlin.txt",
    "python/tests/test_json_integers.py reads docs/parity.md",
    "python/tests/test_landing_snippets.py reads site/lib/landing-snippets.ts",
    "python/tests/test_landing_snippets.py reads site/scripts/check-language-examples.ts",
    "python/tests/test_worker_defaults.py reads docs/parity.md",
  ]);

  // Helpers in the TypeScript tree that another lane runs.
  const runElsewhere = new Set([
    "typescript/core/test/packed-packages.ts", // the packed lane
    "typescript/core/test/site-nginx-smoke.ts", // the demo lane
    "typescript/core/test/site-smoke.ts", // the demo lane
    "typescript/core/test/support/parity-capabilities.ts", // unit tests and `pnpm parity:check`
  ]);

  it.each(FILTERED_LANE_NAMES)("names every file that a source of %s reads", (lane) => {
    const { sources, inputs } = FILTERED_LANES[lane];
    const covered = [...SHARED_INPUTS, ...inputs];
    const missing = new Set<string>();
    for (const file of trackedFiles) {
      if (
        !matchesAny(file, sources) ||
        !textFile.test(file) ||
        unitTest(file) ||
        runElsewhere.has(file)
      )
        continue;
      for (const line of readFileSync(path.join(repository, file), "utf8").split("\n")) {
        if (commentLine.test(line)) continue;
        for (const [, match = ""] of line.matchAll(reference)) {
          const candidates = [match, match.replace(/\.js$/, ".ts")];
          const target = candidates.find((candidate) => tracked.has(candidate));
          if (!target || mentions.has(`${file} reads ${target}`)) continue;
          // A TypeScript program that the lane runs also reads every module that it imports.
          for (const read of /\.[cm]?ts$/.test(target) ? importClosure(target) : [target])
            if (!matchesAny(read, covered)) missing.add(`${file} reads ${read}`);
        }
      }
    }
    expect([...missing].toSorted()).toEqual([]);
  });

  // A source can also build a path from parts, such as `REPOSITORY / "docs" / "guides"`. The scan
  // above cannot resolve such a path. This test finds the name of a directory that runs no filtered
  // lane as a string literal in a source. The source must then be in this list, with the globs that
  // it reads, and the lane must name those globs as inputs. Other directory names, such as `go` or
  // `api`, are also common words in the sources, so the test does not look for them.
  const pathPartReads: Record<string, readonly string[]> = {
    "python/tests/test_public_surface.py": ["docs/guides/*.md", "site/content/docs/*.mdx"],
    // A path relative to typescript/core, not the top-level benchmarks directory.
    "typescript/core/benchmarks/run.ts": [],
  };
  const directoryName = /["'](benchmarks|docs|site)["']/g;

  it.each(FILTERED_LANE_NAMES)(
    "names every directory that a source of %s reads in parts",
    (lane) => {
      const { sources, inputs } = FILTERED_LANES[lane];
      const covered = [...SHARED_INPUTS, ...inputs];
      const readsWhole = (directory: string): boolean =>
        trackedFiles
          .filter((file) => file.startsWith(`${directory}/`))
          .every((file) => matchesAny(file, covered));
      const problems = new Set<string>();
      for (const file of trackedFiles) {
        if (
          !matchesAny(file, sources) ||
          !textFile.test(file) ||
          unitTest(file) ||
          runElsewhere.has(file)
        )
          continue;
        for (const line of readFileSync(path.join(repository, file), "utf8").split("\n")) {
          if (commentLine.test(line)) continue;
          for (const [, directory = ""] of line.matchAll(directoryName)) {
            if (readsWhole(directory)) continue;
            const reads = pathPartReads[file];
            if (!reads) problems.add(`${file} names ${directory}`);
            else
              for (const glob of reads)
                if (!covered.includes(glob)) problems.add(`${lane} omits ${glob}`);
          }
        }
      }
      expect([...problems].toSorted()).toEqual([]);
    },
  );
});

describe("selecting lanes for a pull request", () => {
  const weekly = Object.fromEntries(WEEKLY_LANES.map((lane) => [lane, false]));

  // The filtered lanes that the change runs. A docs-only change runs only the doc-check lanes of
  // the always-run lanes, and any other change runs each of them.
  function selected(files: readonly string[]): string[] {
    const { plan } = planLanes("pull_request", "", files);
    const docsOnly = files.length > 0 && files.every((file) => matchesAny(file, DOC_PATHS));
    const always = Object.fromEntries(
      ALWAYS_RUN_LANES.map((lane) => [
        lane,
        !docsOnly || (DOC_CHECK_LANES as readonly string[]).includes(lane),
      ]),
    );
    expect(plan).toMatchObject({ ...always, ...weekly });
    return FILTERED_LANE_NAMES.filter((lane) => plan[lane]).toSorted();
  }

  const everyLane = FILTERED_LANE_NAMES.filter(
    (lane) => !(WEEKLY_LANES as readonly string[]).includes(lane),
  ).toSorted();

  it("runs no filtered lane for a change to an architecture page", () => {
    expect(selected(["docs/architecture/lifecycle.md"])).toEqual([]);
  });

  // test_public_surface.py imports each `python` fence of the guides and the site pages.
  it("runs the Python lane for a change to a guide or a site page", () => {
    expect(selected(["docs/guides/230-payload-contracts.md"])).toEqual(["python"]);
    expect(selected(["site/content/docs/contracts.mdx"])).toEqual(["python"]);
  });

  it("runs the Rust lane for a change to the generated Rust conformance page", () => {
    expect(selected(["docs/rust-conformance.md"])).toEqual(["rust"]);
  });

  // Go, Python, and Rust compare their metrics with a TypeScript program that imports the adapter.
  it("runs every lane that reads the OpenTelemetry adapter for a change to it", () => {
    expect(selected(["typescript/otel/src/index.ts"])).toEqual([
      "go",
      "python",
      "runtime-smoke",
      "rust",
      "typescript",
    ]);
  });

  it("runs every lane for a file that the map does not name", () => {
    expect(selectLanes(["go/worker.go", "Dockerfile"])).toEqual({
      all: true,
      reason: "the lane-input map does not name Dockerfile",
    });
    expect(selected(["Dockerfile"])).toEqual(everyLane);
  });

  it.each([
    "protocol/v1/contracts.json",
    "sql/schema/current.sql",
    "dashboard/v1/conformance.json",
    "typescript/core/test/support/db.ts",
    "go/sql_catalogue_generated.go",
    "rust/src/dashboard/v1_generated.rs",
    "pnpm-lock.yaml",
    ".github/workflows/ci.yml",
  ])("runs every lane for a change to the shared input %s", (file) => {
    expect(selected([file])).toEqual(everyLane);
  });

  it("runs every lane for a change without files", () => {
    expect(selected([])).toEqual(everyLane);
  });

  // The changed files of recent pull requests, from `git show --name-only --no-renames`.
  it.each([
    {
      change: "SM-1582, a Go worker change",
      files: [
        "docs/architecture/lifecycle.md",
        "go/CHANGELOG.md",
        "go/worker.go",
        "go/worker_dispatch_internal_test.go",
      ],
      lanes: ["go", "typescript"],
    },
    {
      change: "SM-1584, a Python worker change",
      files: [
        "docs/architecture/lifecycle.md",
        "docs/architecture/overview.md",
        "docs/architecture/schema-and-protocol.md",
        "docs/guides/390-connection-pooling.md",
        "python/CHANGELOG.md",
        "python/src/workhorse/_pool_hub.py",
        "python/tests/test_pool_hub.py",
        "site/content/docs/pgbouncer.mdx",
      ],
      lanes: ["python"],
    },
    {
      change: "SM-1588, a benchmark analysis",
      files: ["docs/benchmarks/2026-10-21-connection-budget-acceptance-analysis.md"],
      lanes: [],
    },
    {
      change: "SM-1580, a JVM worker change",
      files: [
        "docs/architecture/lifecycle.md",
        "docs/architecture/schema-and-protocol.md",
        "jvm/CHANGELOG.md",
        "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
        "jvm/workhorse/src/test/java/run/workhorse/internal/ListenerDatabaseTest.java",
      ],
      lanes: ["jvm", "python", "spring-boot"],
    },
    {
      change: "SM-1572, a Rust worker change",
      files: [
        "docs/guides/390-connection-pooling.md",
        "rust/CHANGELOG.md",
        "rust/src/worker/heartbeat.rs",
        "rust/tests/worker_postgres.rs",
        "site/content/docs/pgcat.mdx",
      ],
      lanes: ["python", "rust"],
    },
    {
      change: "SM-1577, a Ruby worker change",
      files: [
        "api/ruby.txt",
        "docs/guides/390-connection-pooling.md",
        "ruby/lib/stablemates/workhorse/worker/heartbeat.rb",
        "ruby/spec/unit/listener_spec.rb",
        "site/content/docs/pgbouncer.mdx",
      ],
      lanes: ["python", "ruby"],
    },
    {
      change: "SM-1500, a documentation change",
      files: [
        "SECURITY.md",
        "docs/compatibility.md",
        "docs/parity.md",
        "jvm/README.md",
        "site/content/docs/installation.mdx",
      ],
      lanes: ["jvm", "python", "spring-boot"],
    },
    {
      change: "SM-1567, a Go toolchain pin",
      files: ["go/CHANGELOG.md", "go/go.mod", "mise.toml", "support.json"],
      lanes: everyLane,
    },
    {
      change: "SM-1583, a dependency update",
      files: ["dashboard/app/package.json", "package.json", "pnpm-lock.yaml"],
      lanes: everyLane,
    },
    {
      change: "SM-1585, a change to the TypeScript reference",
      files: ["typescript/core/src/worker.ts", "python/src/workhorse/worker.py"],
      lanes: everyLane,
    },
  ])("runs the lanes of $change", ({ files, lanes }) => {
    expect(selected(files)).toEqual([...lanes].toSorted());
  });
});

function alwaysRun(files: readonly string[]): string[] {
  const { plan } = planLanes("pull_request", "", files);
  return ALWAYS_RUN_LANES.filter((lane) => plan[lane]).toSorted();
}

describe("a docs-only pull request", () => {
  // SM-1585 (PR #901) changed three documentation files.
  const docsChange = [
    "docs/architecture/overview.md",
    "docs/guides/390-connection-pooling.md",
    "site/content/docs/pgbouncer.mdx",
  ];

  it("runs only the always-run lanes that check the documentation", () => {
    expect(alwaysRun(docsChange)).toEqual([...DOC_CHECK_LANES].toSorted());
    expect(alwaysRun(["README.md", "api/README.md", "docs/decisions/0083-x.md"])).toEqual(
      [...DOC_CHECK_LANES].toSorted(),
    );
    expect(planLanes("pull_request", "", docsChange).reason).toBe(
      "the change is docs-only, so it runs static, npm-release-scope, demo and python",
    );
  });

  it.each([
    "go/worker.go",
    "python/README.md",
    "LICENSE",
    "benchmarks/README.md",
    ".oxlintrc.json",
    "Dockerfile",
    "scripts/ci-lanes.ts",
  ])("runs every always-run lane and the lanes of %s with documentation", (file) => {
    expect(alwaysRun([...docsChange, file])).toEqual([...ALWAYS_RUN_LANES].toSorted());
    const { plan } = planLanes("pull_request", "", [file]);
    const { plan: mixed } = planLanes("pull_request", "", [...docsChange, file]);
    const lanes = FILTERED_LANE_NAMES.filter((lane) => plan[lane]);
    expect(lanes.filter((lane) => !mixed[lane])).toEqual([]);
  });

  // The weekly packed lane reads docs/** and site/**, but a pull request never runs it.
  it("names no lane that the event skips in the plan reason", () => {
    expect(planLanes("pull_request", "", ["docs/architecture/overview.md"]).reason).toBe(
      "the change is docs-only, so it runs static, npm-release-scope, demo and no filtered lane",
    );
    expect(planLanes("pull_request", "", ["dashboard/app/src/main.tsx"]).reason).not.toContain(
      "packed",
    );
  });

  it("is not a change without files", () => {
    expect(isDocsOnlyChange([])).toBe(false);
  });

  it.each(DOC_PATHS)("never runs every lane for a tracked file of %s", (glob) => {
    const files = trackedFiles.filter((file) => matchesGlob(file, glob));
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => selectLanes([file]).all)).toEqual([]);
    expect(ALWAYS_RUN_LANE_INPUTS).toContain(glob);
  });

  it("keeps the doc-check lanes in the always-run lanes", () => {
    for (const lane of DOC_CHECK_LANES) expect(ALWAYS_RUN_LANES).toContain(lane);
  });

  // The lanes that a docs-only change skips must check nothing in the documentation. If a step is
  // added to one of them, decide whether it reads the documentation, then update this list.
  const skippedLaneRuns: Record<string, readonly string[]> = {
    unit: [
      "pnpm install --frozen-lockfile",
      "uv sync --project python",
      "pnpm npm:test:python-toolchain",
    ],
  };

  it("skips only the lanes whose steps this test knows", () => {
    const skipped = ALWAYS_RUN_LANES.filter(
      (lane) => !(DOC_CHECK_LANES as readonly string[]).includes(lane),
    );
    expect(Object.keys(skippedLaneRuns).toSorted()).toEqual([...skipped].toSorted());
    for (const lane of skipped) {
      const runs = (workflow.jobs[lane]?.steps ?? []).flatMap((step) =>
        step.run ? [step.run.trim()] : [],
      );
      expect(runs).toEqual(skippedLaneRuns[lane]);
    }
  });

  it("skips no test that reads the documentation", () => {
    const docReference = /(?:^|[^\w./-])(?:\.\.\/)*((?:docs|site)\/[\w./-]*|[\w-]+\.mdx?\b)/;
    const directoryName = /["'](docs|site|guides)["']/;
    const reads: string[] = [];
    for (const entry of pythonToolchainTestFiles)
      for (const file of importClosure(entry))
        for (const line of readFileSync(path.join(repository, file), "utf8").split("\n"))
          if (docReference.test(line) || directoryName.test(line)) reads.push(`${file}: ${line}`);
    expect(reads).toEqual([]);
  });

  // Each check that reads the documentation, with the lane that runs it.
  it.each([
    ["static", "pnpm exec oxfmt --check ."],
    ["static", `pnpm exec ${packageScripts.lint?.split(" && ")[0] ?? ""}`],
    ["static", "pnpm lint:dead-code"],
    ["static", "pnpm typecheck"],
    ["demo", "pnpm build"],
    ["demo", "pnpm test:site-smoke:built"],
    ["npm-release-scope", "pnpm npm:test:unit"],
  ])("runs in the %s lane: %s", (lane, run) => {
    expect((DOC_CHECK_LANES as readonly string[]).includes(lane)).toBe(true);
    const runs = (workflow.jobs[lane]?.steps ?? []).map((step) => step.run?.trim());
    expect(runs).toContain(run);
  });

  it.each([
    "scripts/comparison-names.test.ts",
    "scripts/glossary-avoid-words.test.ts",
    "scripts/guide-examples.test.ts",
    "scripts/guide-reference-values.test.ts",
    "typescript/core/test/site-guide-coverage.test.ts",
  ])("runs %s in the npm release test scope", (file) => {
    expect(tracked.has(file)).toBe(true);
    expect(matchesAny(file, [...databaseTestFiles, ...pythonToolchainTestFiles])).toBe(false);
  });
});

// The steps of the static job that read the files of one language only, by the filtered lane whose
// inputs hold each file that the step reads. A step runs only when the plan selects that lane. The
// other steps are cross-language checks and their setup, and they run in every run. For example, the
// generated catalogues need gofmt, rustfmt, and ruff, so the Go, Rust, and uv setup always runs.
// pnpm go:fmt:check and pnpm go:lint also read benchmarks/connection-budget/go-probe, which the go
// lane does not read, so they always run.
const staticLanguageSteps: Record<string, readonly string[]> = {
  jvm: [
    "gradle/actions/setup-gradle",
    'rm -rf "$RUNNER_TEMP/.gradle-actions/gradle-installations"',
    "actions/setup-java",
    "pnpm java-api:check",
    "pnpm kotlin-api:check",
    "pnpm jvm:format:check",
    "pnpm jvm:lint",
    "pnpm jvm:vuln",
  ],
  dotnet: ["actions/setup-dotnet", "pnpm dotnet-api:check", "pnpm dotnet:lint", "pnpm dotnet:vuln"],
  ruby: ["ruby/setup-ruby", "pnpm ruby-api:check", "pnpm ruby:lint", "pnpm ruby:vuln"],
  rust: ["taiki-e/install-action", "pnpm rust:vuln"],
  python: [
    "pnpm python-api:check",
    "pnpm python:format:check",
    "pnpm python:lint",
    "pnpm python:vuln",
  ],
  go: ["pnpm go-api:check", "pnpm go:vuln"],
};

/** The action of a step without its version, or the first line of its command. */
function stepKey(step: Step): string {
  return step.uses?.split("@")[0] ?? step.run?.trim().split("\n")[0] ?? "";
}

function laneOfStaticStep(step: Step): string | undefined {
  const key = stepKey(step);
  return Object.keys(staticLanguageSteps).find((lane) => staticLanguageSteps[lane]?.includes(key));
}

function laneCondition(lane: string): string {
  return `fromJSON(needs.plan.outputs.lanes)['${lane}']`;
}

const staticSteps = workflow.jobs.static?.steps ?? [];

/** The steps of the static job that can run on a pull request with these changed files. */
function staticStepsThatRun(files: readonly string[]): string[] {
  const { plan } = planLanes("pull_request", "", files);
  return staticSteps
    .filter((step) => {
      const lane = laneOfStaticStep(step);
      return lane === undefined || plan[lane as FilteredLaneName];
    })
    .map(stepKey);
}

describe("the static job", () => {
  it("runs each language step only when the plan selects its lane", () => {
    const problems: string[] = [];
    for (const step of staticSteps) {
      const lane = laneOfStaticStep(step);
      const condition = step.if ?? "";
      if (lane !== undefined) {
        const gate = laneCondition(lane);
        if (condition !== gate && !condition.startsWith(`${gate} && `))
          problems.push(`${stepKey(step)} runs without the ${lane} lane`);
      } else if (condition.includes("needs.plan.outputs.lanes"))
        problems.push(`${stepKey(step)} has a lane condition but no lane in this test`);
    }
    expect(problems).toEqual([]);
  });

  it("has each language step that this test names", () => {
    const keys = new Set(staticSteps.map(stepKey));
    const missing = Object.values(staticLanguageSteps)
      .flat()
      .filter((key) => !keys.has(key));
    expect(missing).toEqual([]);
  });

  // The job runs the parts of `pnpm lint` and `pnpm format:check` as separate steps, so that the
  // part of one language can skip. A part that a later change adds to a script must get a step.
  it.each(["format:check", "lint", "typecheck"])("runs each part of pnpm %s", (script) => {
    const runs = new Set(staticSteps.flatMap((step) => (step.run ? [step.run.trim()] : [])));
    if (runs.has(`pnpm ${script}`)) return;
    const parts = (packageScripts[script] ?? "").split(" && ");
    expect(parts.length).toBeGreaterThan(1);
    const missing = parts
      .map((part) => (part.startsWith("pnpm ") ? part : `pnpm exec ${part}`))
      .filter((run) => !runs.has(run));
    expect(missing).toEqual([]);
  });

  it.each([
    "pnpm exec oxfmt --check .",
    "pnpm sql-catalogues:check",
    "pnpm go:sqlc:check",
    "pnpm dashboard-spec:check",
    "pnpm go:fmt:check",
    "pnpm go:lint",
    "pnpm typecheck",
  ])("runs the cross-language step %s in every run", (run) => {
    const step = staticSteps.find((candidate) => candidate.run?.trim() === run);
    expect(step).toBeDefined();
    expect(step?.if).toBeUndefined();
  });

  // SM-1584 changed Python and the documentation only.
  it("runs no JVM, .NET, Rust, or Ruby step for a Python change", () => {
    const runs = staticStepsThatRun([
      "docs/guides/390-connection-pooling.md",
      "python/src/workhorse/_pool_hub.py",
      "python/tests/test_pool_hub.py",
    ]);
    const other = new Set(
      ["jvm", "dotnet", "rust", "ruby"].flatMap((lane) => staticLanguageSteps[lane] ?? []),
    );
    expect(runs.filter((key) => other.has(key))).toEqual([]);
    expect(runs).toContain("pnpm python:lint");
  });

  it.each([".github/workflows/ci.yml", "pnpm-lock.yaml", "sql/schema/current.sql", "Dockerfile"])(
    "runs every step for a change to %s",
    (file) => {
      expect(staticStepsThatRun([file])).toEqual(staticSteps.map(stepKey));
    },
  );

  // A file that a language step reads must select the lane of the step.
  it.each([
    ["jvm", "jvm/build.gradle.kts"],
    ["jvm", "api/java.txt"],
    ["jvm", "api/kotlin.txt"],
    ["dotnet", "dotnet/Workhorse.slnx"],
    ["dotnet", "api/dotnet.txt"],
    ["ruby", "ruby/.rubocop.yml"],
    ["ruby", "ruby/Gemfile.lock"],
    ["ruby", "api/ruby.txt"],
    ["rust", "Cargo.toml"],
    ["rust", "Cargo.lock"],
    ["rust", "deny.toml"],
    ["python", "python/pyproject.toml"],
    ["python", "python/uv.lock"],
    ["python", "api/python.txt"],
    ["go", "go/go.sum"],
    ["go", "api/go.txt"],
  ])("selects the %s lane for a change to %s", (lane, file) => {
    expect(tracked.has(file)).toBe(true);
    const selection = selectLanes([file]);
    expect(selection.all || selection.lanes.has(lane as FilteredLaneName)).toBe(true);
    expect(staticStepsThatRun([file])).toEqual(
      expect.arrayContaining([...(staticLanguageSteps[lane] ?? [])]),
    );
  });
});

describe("the JVM verification metadata lane", () => {
  // The files that decide which plugins and libraries Gradle resolves.
  const resolutionFiles = trackedFiles.filter((file) =>
    matchesAny(file, [
      "jvm/**/*.gradle.kts",
      "jvm/gradle/**",
      "jvm/gradle.properties",
      "jvm/release-consumer/**",
    ]),
  );

  it.each(resolutionFiles)("runs for a change to %s", (file) => {
    const selection = selectLanes([file]);
    expect(selection.all || selection.lanes.has("jvm-verification-metadata")).toBe(true);
  });

  it("runs for a change to the version catalogue", () => {
    expect(resolutionFiles).toContain("jvm/gradle/libs.versions.toml");
  });

  it("skips a change to the JVM sources", () => {
    const files = [
      "jvm/workhorse/src/main/java/run/workhorse/Worker.java",
      "jvm/workhorse-kotlin/src/main/kotlin/run/workhorse/kotlin/Blocking.kt",
      "jvm/README.md",
    ];
    for (const file of files) {
      expect(tracked.has(file)).toBe(true);
      const selection = selectLanes([file]);
      const lanes = selection.all ? undefined : [...selection.lanes];
      expect(lanes).toContain("jvm");
      expect(lanes).not.toContain("jvm-verification-metadata");
    }
  });
});

describe("planning lanes for a push to main", () => {
  const nonWeekly = Object.fromEntries(
    LANE_NAMES.map((lane) => [lane, !(WEEKLY_LANES as readonly string[]).includes(lane)]),
  );

  // The files of the 0.11.0 release candidate commit: the version of each line, the changelog of
  // each line, the documentation that names the version, and the frozen schema of the release.
  const releaseCandidate = [
    "CHANGELOG.md",
    "Cargo.lock",
    "api/go.txt",
    "api/typescript.txt",
    "dashboard/app/package.json",
    "docs/compatibility.md",
    "docs/schema-lifecycle.md",
    "dotnet/CHANGELOG.md",
    "dotnet/Directory.Build.props",
    "dotnet/README.md",
    "go/CHANGELOG.md",
    "go/version.go",
    "jvm/CHANGELOG.md",
    "jvm/gradle.properties",
    "python/CHANGELOG.md",
    "python/pyproject.toml",
    "python/src/workhorse/_version.py",
    "python/uv.lock",
    "ruby/CHANGELOG.md",
    "ruby/Gemfile.lock",
    "ruby/gemfiles/rails_8_0.gemfile.lock",
    "ruby/lib/stablemates/workhorse/version.rb",
    "rust/CHANGELOG.md",
    "rust/Cargo.toml",
    "site/content/docs/releases.mdx",
    "sql/releases/0089.sql",
    "support.json",
    "typescript/core/package.json",
    "typescript/core/src/version.ts",
    "typescript/otel/CHANGELOG.md",
    "typescript/otel/package.json",
  ];

  it("runs every lane for the release candidate commit", () => {
    const { plan, reason } = planLanes("push", "", releaseCandidate);
    expect(plan).toEqual(nonWeekly);
    expect(reason).toMatch(/is a release file$/);
  });

  // Each kind of file that scripts/check-release.ts reads for the release version or the frozen
  // schema, and each release workflow. Each one alone runs every lane.
  it.each([
    "CHANGELOG.md",
    "python/CHANGELOG.md",
    "go/CHANGELOG.md",
    "rust/CHANGELOG.md",
    "ruby/CHANGELOG.md",
    "jvm/CHANGELOG.md",
    "dotnet/CHANGELOG.md",
    "typescript/otel/CHANGELOG.md",
    "typescript/knex/package.json",
    "dashboard/app/package.json",
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
    "ruby/gemfiles/rails_8_0.gemfile.lock",
    "sql/releases/0089.sql",
    ".github/workflows/release.yml",
    ".github/workflows/release-python.yml",
  ])("runs every lane for a push that changes the release file %s", (file) => {
    expect(RELEASE_FILES.some((glob) => matchesGlob(file, glob))).toBe(true);
    expect(planLanes("push", "", [file]).plan).toEqual(nonWeekly);
  });

  // A file that the release check reads, a changelog, or a release workflow runs every lane when a
  // push changes it, as a release file or as a shared input.
  it("runs every lane for each file that the release check reads", () => {
    const source = readFileSync(path.join(repository, "scripts/check-release.ts"), "utf8");
    const named = [...source.matchAll(/"([\w./-]+\.\w+)"/g)]
      .map((match) => match[1] ?? "")
      .filter((file) => tracked.has(file));
    const files = [
      ...named,
      ...trackedFiles.filter(
        (file) =>
          file.endsWith("CHANGELOG.md") ||
          matchesGlob(file, ".github/workflows/release*.yml") ||
          matchesGlob(file, "ruby/gemfiles/*.lock"),
      ),
    ];
    expect(named.length).toBeGreaterThan(10);
    const narrowed = files.filter(
      (file) => JSON.stringify(planLanes("push", "", [file]).plan) !== JSON.stringify(nonWeekly),
    );
    expect(narrowed).toEqual([]);
  });

  it("runs only the Python lane and the always-run lanes for a Python-only push", () => {
    const { plan, reason } = planLanes("push", "", [
      "python/src/workhorse/worker.py",
      "python/tests/test_worker.py",
    ]);
    expect(plan).toEqual(
      Object.fromEntries(
        LANE_NAMES.map((lane) => [
          lane,
          (ALWAYS_RUN_LANES as readonly string[]).includes(lane) || lane === "python",
        ]),
      ),
    );
    expect(reason).toBe("the change runs python");
  });

  it("runs the doc-check lanes for a docs-only push", () => {
    const { plan } = planLanes("push", "", ["docs/architecture/overview.md"]);
    expect(plan).toEqual(
      Object.fromEntries(
        LANE_NAMES.map((lane) => [lane, (DOC_CHECK_LANES as readonly string[]).includes(lane)]),
      ),
    );
  });

  it("runs every lane for a push that changes a shared input", () => {
    expect(planLanes("push", "", ["scripts/ci-lanes.ts"]).plan).toEqual(nonWeekly);
  });

  it("runs every lane when a push cannot list its files", () => {
    const { plan, reason } = planLanes("push", "", undefined);
    expect(plan).toEqual(nonWeekly);
    expect(reason).toBe("the plan could not list the changed files");
  });

  it("runs every lane for a push without files", () => {
    expect(planLanes("push", "", []).plan).toEqual(nonWeekly);
  });

  const head = "b".repeat(40);
  const before = "a".repeat(40);

  it("compares a fast-forward push with the commit before it", () => {
    expect(pushBase({ before, after: head, forced: false, created: false }, head)).toEqual({
      base: before,
    });
  });

  it.each([
    ["a missing before SHA", { after: head }],
    ["an empty before SHA", { before: "", after: head }],
    ["an all-zero before SHA", { before: "0".repeat(40), after: head }],
    ["a malformed before SHA", { before: "main", after: head }],
    ["a new branch", { before, after: head, created: true }],
    ["a force push", { before, after: head, forced: true }],
    ["a push whose after SHA is not the checked-out commit", { before, after: "c".repeat(40) }],
    ["a payload that is not an object", null],
  ])("lists no files for %s", (_name, event) => {
    expect(pushBase(event, head)).toHaveProperty("reason");
  });
});

describe("listing the files of a push", () => {
  const head = "b".repeat(40);
  const before = "a".repeat(40);
  const directory = mkdtempSync(path.join(tmpdir(), "ci-lanes-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  function eventFile(name: string, contents: string): string {
    const file = path.join(directory, name);
    writeFileSync(file, contents);
    return file;
  }
  const fastForward = eventFile(
    "push.json",
    JSON.stringify({ before, after: head, forced: false, created: false }),
  );

  // A git stand-in that fails the one command whose first argument is `fails`.
  function fakeGit(fails?: string) {
    const calls: string[][] = [];
    const git = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args[0] === fails) throw new Error(`git ${args[0]} failed`);
      if (args[0] === "rev-parse") return `${head}\n`;
      if (args[0] === "diff")
        return "python/src/workhorse/worker.py\0python/tests/test_worker.py\0";
      return "";
    };
    return { git, calls };
  }

  async function listed(eventPath: string | undefined, fails?: string) {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const fake = fakeGit(fails);
      return { files: await pushFiles(eventPath, fake.git), calls: fake.calls };
    } finally {
      stderr.mockRestore();
    }
  }

  it("lists the files between the before commit and the pushed commit", async () => {
    const { files, calls } = await listed(fastForward);
    expect(files).toEqual(["python/src/workhorse/worker.py", "python/tests/test_worker.py"]);
    expect(calls).toContainEqual(["merge-base", "--is-ancestor", before, head]);
    expect(calls.at(-1)).toEqual(["diff", "--name-only", "--no-renames", "-z", before, head]);
  });

  it.each(["rev-parse", "fetch", "merge-base", "diff"])(
    "lists no files when git %s fails",
    async (command) => {
      expect((await listed(fastForward, command)).files).toBeUndefined();
    },
  );

  it("lists no files without an event file", async () => {
    expect((await listed(undefined)).files).toBeUndefined();
    expect((await listed(path.join(directory, "missing.json"))).files).toBeUndefined();
  });

  it("lists no files for an event file that is not JSON", async () => {
    expect((await listed(eventFile("bad.json", "not json"))).files).toBeUndefined();
  });

  it("fetches nothing for a force push", async () => {
    const forced = eventFile(
      "forced.json",
      JSON.stringify({ before, after: head, forced: true, created: false }),
    );
    const { files, calls } = await listed(forced);
    expect(files).toBeUndefined();
    expect(calls.map((call) => call[0])).toEqual(["rev-parse"]);
  });
});

describe("publishing the lane plan", () => {
  it("writes the plan that the run uses to LANE_PLAN_PATH", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "workhorse-lane-plan-"));
    try {
      const planPath = path.join(directory, LANE_PLAN_FILE);
      const sha = "c".repeat(40);
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/ci-lanes.ts", "workflow_dispatch"],
        {
          cwd: repository,
          encoding: "utf8",
          env: {
            ...process.env,
            LANE_PLAN_PATH: planPath,
            GITHUB_SHA: sha,
            GITHUB_RUN_ID: "42",
            GITHUB_RUN_ATTEMPT: "3",
            GITHUB_STEP_SUMMARY: "",
          },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const { plan, reason } = planLanes("workflow_dispatch", "", undefined);
      expect(output).toBe(`lanes=${JSON.stringify(plan)}\n`);
      expect(JSON.parse(readFileSync(planPath, "utf8"))).toEqual(
        lanePlanRecord({ event: "workflow_dispatch", sha, runId: 42, runAttempt: 3 }, plan, reason),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("planning lanes for other events", () => {
  it.each(["workflow_dispatch"])("runs every lane on %s", (event) => {
    const { plan } = planLanes(event, "", undefined);
    expect(plan).toEqual(
      Object.fromEntries(
        LANE_NAMES.map((lane) => [
          lane,
          event === "workflow_dispatch" || !(WEEKLY_LANES as readonly string[]).includes(lane),
        ]),
      ),
    );
  });

  it("runs every lane on the weekly schedule", () => {
    const { plan } = planLanes("schedule", WEEKLY_COMPATIBILITY_SCHEDULE, undefined);
    expect(Object.values(plan).every(Boolean)).toBe(true);
  });

  it("runs no lane on a schedule that the workflow does not know", () => {
    const { plan } = planLanes("schedule", "0 0 * * *", undefined);
    expect(Object.values(plan).some(Boolean)).toBe(false);
  });

  it("runs every lane when a pull request cannot list its files", () => {
    const { plan, reason } = planLanes("pull_request", "", undefined);
    expect(reason).toBe("the plan could not list the changed files");
    expect(plan).toEqual(
      Object.fromEntries(
        LANE_NAMES.map((lane) => [lane, !(WEEKLY_LANES as readonly string[]).includes(lane)]),
      ),
    );
  });
});

describe("matching a glob", () => {
  it.each([
    ["docs/guides/a.md", "docs/**", true],
    ["docs", "docs/**", false],
    ["README.md", "*.md", true],
    ["docs/README.md", "*.md", false],
    ["tsconfig.build.json", "tsconfig*.json", true],
    ["jvm/a/b/V1.java", "jvm/**/V1.java", true],
    ["jvm/V1.java", "jvm/**/V1.java", true],
    ["api/telemetryXtxt", "api/telemetry.txt", false],
  ])("matches %s against %s: %s", (file, glob, expected) => {
    expect(matchesGlob(file, glob)).toBe(expected);
  });
});
