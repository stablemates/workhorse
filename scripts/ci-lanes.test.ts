import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  ALWAYS_RUN_LANE_INPUTS,
  ALWAYS_RUN_LANES,
  FILTERED_LANE_NAMES,
  FILTERED_LANES,
  LANE_NAMES,
  matchesGlob,
  planLanes,
  SHARED_INPUTS,
  selectLanes,
  WEEKLY_LANES,
} from "./ci-lanes.js";
import { databaseTestFiles } from "../vitest.config.js";
import { WEEKLY_COMPATIBILITY_SCHEDULE } from "./ci-matrix.js";

const repository = path.resolve(import.meta.dirname, "..");
const trackedFiles = execFileSync("git", ["ls-files", "-z"], { cwd: repository, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const tracked = new Set(trackedFiles);

interface Job {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly "continue-on-error"?: boolean;
  readonly outputs?: Record<string, string>;
}
const workflow = parse(readFileSync(path.join(repository, ".github/workflows/ci.yml"), "utf8")) as {
  readonly jobs: Record<string, Job>;
};
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
    const sourceDirectories = ["dashboard/", "docs/", "go/", "jvm/", "python/", "ruby/", "rust/"];
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
  const textFile = /\.(?:go|rs|rb|py|java|kt|kts|ts|mts|js|mjs|json|toml|ya?ml|gemspec|sh)$/;

  // Paths that a source names in prose, such as a Python docstring, without reading the file.
  const mentions = new Set([
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
  const always = Object.fromEntries(ALWAYS_RUN_LANES.map((lane) => [lane, true]));
  const weekly = Object.fromEntries(WEEKLY_LANES.map((lane) => [lane, false]));

  function selected(files: readonly string[]): string[] {
    const { plan } = planLanes("pull_request", "", files);
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
      lanes: ["jvm", "jvm-verification-metadata", "python", "spring-boot"],
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
      lanes: ["jvm", "jvm-verification-metadata", "python", "spring-boot"],
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

describe("planning lanes for other events", () => {
  it.each(["push", "workflow_dispatch"])("runs every lane on %s", (event) => {
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
