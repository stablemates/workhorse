import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

const config = await readFile(path.resolve(import.meta.dirname, "../lefthook.yml"), "utf8");

interface Job {
  readonly name?: string;
  readonly glob?: string;
  readonly run?: string;
  readonly group?: {
    readonly parallel?: boolean;
    readonly piped?: boolean;
    readonly jobs: readonly Job[];
  };
}
interface Hook {
  readonly piped?: boolean;
  readonly parallel?: boolean;
  readonly jobs: readonly Job[];
}
const hooks = parse(config) as Record<string, Hook>;

describe("lefthook Rust and generated-artifact routing", () => {
  it("routes staged Rust files to the pinned formatter", () => {
    expect(config).toContain(
      'glob: "{rust/**/*.rs,rust/Cargo.toml,rust/Cargo.lock,rustfmt.toml,rust/rust-toolchain.toml}"',
    );
    expect(config).toContain("run: mise exec -- pnpm rust:format:check");
    expect(config).toContain('glob: "{rust/**/*.rs,rust/Cargo.toml,rust/Cargo.lock}"');
    expect(config).toContain("run: mise exec -- pnpm rust:test:unit\n");
    expect(config).toContain('glob: "**/*.{ts,tsx,js,jsx,mjs,cjs,json,md,yml,yaml}"');
  });

  it("routes Rust, Ruby specs, and generated parity files to their checks", () => {
    expect(config).toContain(
      'glob: "{rust/**,rust/PARITY.md,ruby/spec/**,typescript/core/test/support/parity-capabilities.ts,docs/parity.md,scripts/generate-parity-tables.ts}"',
    );
    expect(config).toContain(
      'glob: "{rust/**,rust/PARITY.md,docs/rust-conformance.md,scripts/generate-rust-conformance.ts}"',
    );
    expect(config).toContain("run: mise exec -- pnpm parity:check");
    expect(config).toContain(
      "run: mise exec -- pnpm exec tsx scripts/generate-rust-conformance.ts --check",
    );
  });
});

// Every command a list of jobs runs, including the jobs of nested groups.
function runs(jobs: readonly Job[]): string[] {
  return jobs.flatMap((job) => [...(job.run ? [job.run] : []), ...runs(job.group?.jobs ?? [])]);
}

describe("lefthook pre-commit scope", () => {
  const preCommitRuns = runs(hooks["pre-commit"]!.jobs);

  it("runs the Rust unit scope, not the database suite that CI runs", async () => {
    const { scripts } = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    // Library tests in `rust/src/worker/heartbeat.rs` use a scratch database unless this is set.
    expect(scripts["rust:test:unit"]).toMatch(/^WORKHORSE_NO_DATABASE=1 .* --lib --bins$/);
    expect(preCommitRuns).toContain("mise exec -- pnpm rust:test:unit");
    expect(preCommitRuns).not.toContain("mise exec -- pnpm rust:test");
    expect(preCommitRuns).not.toContain("mise exec -- pnpm rust:integration");
  });

  it("runs no PostgreSQL schema suite after a SQL change", async () => {
    const limits = "typescript/core/test/schema-limits.test.ts";
    expect(preCommitRuns).not.toContain("mise exec -- pnpm test:schema");
    expect(preCommitRuns).toContain(`mise exec -- pnpm test:changed ${limits}`);
    // `test:changed` passes when it selects no test, so a moved file would pass unseen.
    await expect(readFile(path.resolve(import.meta.dirname, "..", limits))).resolves.toBeDefined();
  });

  it("checks the parity tables once", () => {
    // `pnpm rust:conformance:check` also runs `pnpm parity:check`.
    expect(preCommitRuns).not.toContain("mise exec -- pnpm rust:conformance:check");
    expect(preCommitRuns.filter((run) => run.includes("parity:check"))).toHaveLength(1);
  });

  it("routes staged Ruby files to RuboCop and the generated catalogue to its check", () => {
    expect(config).toContain('glob: "ruby/**"');
    expect(config).toContain("run: mise exec -- pnpm ruby:lint");
    expect(config).toContain("ruby/lib/stablemates/workhorse/sql_catalogue_generated.rb}");
  });
});

// The pre-commit jobs, with each command replaced by `echo selected-<n>`, where n indexes `commands`.
function echoJobs(jobs: readonly Job[], commands: string[]): Job[] {
  return jobs.map((job) => {
    const { run, group, ...rest } = job;
    if (group) return { ...rest, group: { ...group, jobs: echoJobs(group.jobs, commands) } };
    if (run === undefined) return job;
    commands.push(run);
    return { ...rest, run: `echo selected-${commands.length - 1}` };
  });
}

// The commands that the pinned lefthook selects for a commit of these files, in the order it runs
// them. Lefthook runs in a scratch repository with every command replaced by `echo`, so its own
// glob rules decide the selection and no check runs.
async function selectedRuns(files: readonly string[]): Promise<string[]> {
  const commands: string[] = [];
  const preCommit = {
    ...hooks["pre-commit"]!,
    jobs: echoJobs(hooks["pre-commit"]!.jobs, commands),
  };
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "workhorse-lefthook-")));
  const { LEFTHOOK: _skip, ...env } = scratchEnvironment(directory);
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8", env }).trim();
    const probe = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: directory,
      encoding: "utf8",
      env,
    });
    expect(probe.status).not.toBe(0);
    git("init", "--quiet", directory);
    expect(git("rev-parse", "--absolute-git-dir")).toBe(path.join(directory, ".git"));
    await writeFile(path.join(directory, "lefthook.yml"), stringify({ "pre-commit": preCommit }));
    for (const file of files) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await writeFile(path.join(directory, file), "probe\n");
    }
    git("add", "--", ...files);
    const result = spawnSync(
      lefthookBinary,
      ["run", "pre-commit", "--no-tty", "--colors", "off", "--no-auto-install"],
      { cwd: directory, encoding: "utf8", env },
    );
    if (result.status !== 0) throw new Error(`lefthook failed: ${result.stderr}`);
    return [...result.stdout.matchAll(/^selected-(\d+)$/gm)].map(
      (match) => commands[Number(match[1])]!,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    expect((await readFile(repositoryConfig)).equals(repositoryConfigBefore)).toBe(true);
  }
}

const lefthookBinary = path.resolve(import.meta.dirname, "../node_modules/.bin/lefthook");

// The files whose commit does not select `run`.
async function missing(files: readonly string[], run: string): Promise<string[]> {
  const selections = await Promise.all(files.map((file) => selectedRuns([file])));
  return files.filter((_, index) => !selections[index]!.includes(run));
}

describe("lefthook pre-commit selection", () => {
  const repository = path.resolve(import.meta.dirname, "..");
  const catalogueCheck = "mise exec -- pnpm sql-catalogues:check";
  // A selected database suite would make the hook need PostgreSQL, which it must not.
  const databaseSuite = /jvm:test|jvm:gates|release-check|test:database|test:schema|db:reset/;

  it("checks the catalogues after a change to each catalogue that the generator writes", async () => {
    const generator = await readFile(
      path.join(repository, "scripts/generate-sql-catalogues.ts"),
      "utf8",
    );
    const catalogues = [...generator.matchAll(/emit\(\s*"([^"]+)"/g)].map((match) => match[1]!);

    expect(catalogues).toContain("rust/src/sql_catalogue_generated.rs");
    expect(catalogues).toContain(
      "jvm/workhorse/src/main/java/run/workhorse/internal/SqlCatalogue.java",
    );
    expect(await missing(catalogues, catalogueCheck)).toEqual([]);
  });

  it("checks the catalogues after a change to the schema or to a generator input", async () => {
    const generator = await readFile(
      path.join(repository, "scripts/generate-sql-catalogues.ts"),
      "utf8",
    );
    const helpers = [...generator.matchAll(/from "\.\/([\w-]+)\.js"/g)].map(
      (match) => `scripts/${match[1]}.ts`,
    );
    const inputs = [
      "sql/schema/current.sql",
      "protocol/v1/manifest.json",
      "protocol/v1/governed-surface.json",
      "dotnet/src/Workhorse.AspNetCore/Internal/DashboardSqlCatalogue.statements.json",
      "scripts/generate-sql-catalogues.ts",
      ...helpers,
    ];

    expect(helpers.length).toBeGreaterThan(0);
    for (const input of inputs)
      await expect(readFile(path.join(repository, input))).resolves.toBeDefined();
    expect(await missing(inputs, catalogueCheck)).toEqual([]);
  });

  it("formats and lints the JVM sources, without the JVM tests", async () => {
    const { scripts } = JSON.parse(
      await readFile(path.join(repository, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    for (const file of [
      "jvm/workhorse/src/main/java/run/workhorse/Admin.java",
      "jvm/api-snapshot/src/main/kotlin/run/workhorse/apisnapshot/KotlinApi.kt",
      "jvm/api-snapshot/build.gradle.kts",
    ]) {
      const selected = await selectedRuns([file]);
      expect(selected.filter((run) => run.includes("jvm:"))).toEqual([
        "mise exec -- pnpm jvm:format:check",
        "mise exec -- pnpm jvm:lint",
      ]);
      expect(selected.filter((run) => databaseSuite.test(run))).toEqual([]);
    }
    expect(scripts["jvm:format:check"]).not.toMatch(/\btest\b/);
    expect(scripts["jvm:lint"]).not.toMatch(/\btest\b/);
  });

  it("runs the two Gradle builds one at a time", () => {
    const checks = hooks["pre-commit"]!.jobs[1]!.group!.jobs;
    const jvm = checks.find((job) => job.name === "check JVM formatting and lint")?.group;
    expect(jvm?.parallel).toBeUndefined();
    expect(jvm?.piped).toBe(true);
  });

  it("selects no database suite for a schema change", async () => {
    const selected = await selectedRuns(["sql/schema/current.sql"]);
    expect(selected).toContain(catalogueCheck);
    expect(selected.filter((run) => databaseSuite.test(run))).toEqual([]);
  });
});

describe("lefthook pre-commit ordering", () => {
  it("builds the declarations alone before the parallel checks read them", () => {
    const preCommit = hooks["pre-commit"]!;
    const [build, checks, ...others] = preCommit.jobs;
    const apiCheck = checks?.group?.jobs.find(
      (job) => job.run === "mise exec -- pnpm typescript-api:check",
    );

    // Piped jobs run in order and stop at the first failure; parallel would race the build.
    expect(preCommit.piped).toBe(true);
    expect(preCommit.parallel).toBeUndefined();
    expect(others).toEqual([]);
    expect(build?.run).toBe("mise exec -- pnpm build:runtime:dev");
    expect(checks?.group?.parallel).toBe(true);
    expect(apiCheck).toBeDefined();
    expect(build?.glob).toBe(apiCheck?.glob);
    expect(checks?.group?.jobs.some((job) => job.run?.includes("build:runtime"))).toBe(false);
  });
});

// Package name to `typecheck` script, for every workspace package under `typescript/` and
// `dashboard/`.
const packageTypecheckScripts = new Map<string, string | undefined>();
for (const parent of ["typescript", "dashboard"]) {
  const directory = path.resolve(import.meta.dirname, "..", parent);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.resolve(directory, entry.name, "package.json");
    const contents = await readFile(manifest, "utf8").catch(() => undefined);
    if (contents === undefined) continue;
    const { name, scripts } = JSON.parse(contents) as {
      name: string;
      scripts?: Record<string, string>;
    };
    packageTypecheckScripts.set(name, scripts?.typecheck);
  }
}

// The package a job type checks through `pnpm --filter <package> typecheck`.
function typecheckedPackage(job: Job): string | undefined {
  return /^mise exec -- pnpm --filter (\S+) typecheck$/.exec(job.run ?? "")?.[1];
}

// The `typecheck` script a job runs through `pnpm --filter <package> typecheck`.
function typecheckScript(job: Job): string | undefined {
  const name = typecheckedPackage(job);
  return name === undefined ? undefined : packageTypecheckScripts.get(name);
}

describe("lefthook package type checks", () => {
  const checks = hooks["pre-commit"]!.jobs[1]!.group!;
  const packageGroup = checks.jobs.find((job) => job.name === "check TypeScript package types");

  it("builds referenced projects, so a worktree without .build/ passes", () => {
    const jobs = packageGroup?.group?.jobs ?? [];
    expect(jobs.length).toBeGreaterThan(0);
    // `tsc -p` reads the outputs of referenced projects but never builds them.
    expect(jobs.filter((job) => !typecheckScript(job)?.startsWith("tsc -b "))).toEqual([]);
  });

  it("runs every `tsc -b` package check one at a time", () => {
    // The builds share referenced projects in .build/typecheck, so parallel runs would write the
    // same declaration files together.
    expect(packageGroup?.group?.parallel).toBeUndefined();
    expect(packageGroup?.group?.piped).toBeUndefined();
    expect(checks.jobs.filter((job) => typecheckScript(job)?.startsWith("tsc -b "))).toEqual([]);
  });

  it("checks every package whose `typecheck` script runs `tsc -b`", () => {
    const checked = new Set((packageGroup?.group?.jobs ?? []).map(typecheckedPackage));
    const unchecked = [...packageTypecheckScripts]
      .filter(([name, script]) => script?.startsWith("tsc -b ") && !checked.has(name))
      .map(([name]) => name);
    expect(unchecked).toEqual([]);
  });
});

function withoutGitVariables(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
}

// A git command that escaped the scratch repository once re-initialized this one and set
// `core.bare`, which broke the primary checkout. The shared config is located without the hook's
// variables, from this checkout's own root, and must be byte-identical after every scratch run.
const repositoryRoot = await realpath(path.resolve(import.meta.dirname, ".."));
const repositoryGit = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: withoutGitVariables(),
  }).trim();
if ((await realpath(repositoryGit("rev-parse", "--show-toplevel"))) !== repositoryRoot) {
  throw new Error(`git resolved a repository other than ${repositoryRoot}`);
}
const repositoryConfig = path.join(
  repositoryGit("rev-parse", "--path-format=absolute", "--git-common-dir"),
  "config",
);
const repositoryConfigBefore = await readFile(repositoryConfig);

// Git exports GIT_DIR, GIT_INDEX_FILE and their siblings to the hooks it runs, and this suite runs
// inside the pre-commit hook. Inherited, they point every git command below at the repository
// being committed to, so the scratch repository is reached only through an environment without
// them, and the test refuses to write until git resolves inside its own directory.
function scratchEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    ...withoutGitVariables(),
    GIT_CEILING_DIRECTORIES: path.dirname(directory),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    PATH: `${directory}${path.delimiter}${process.env.PATH}`,
  };
}

async function runWithFailingInstall(
  script: string,
  prepare: (
    git: (...args: string[]) => string,
    directory: string,
  ) => Promise<Record<string, string>>,
): Promise<{ status: number | null; calls: string[] }> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "workhorse-lefthook-")));
  const env = scratchEnvironment(directory);
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8", env }).trim();
    // Before anything writes, no repository may be reachable from the scratch directory.
    const probe = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: directory,
      encoding: "utf8",
      env,
    });
    expect(probe.status).not.toBe(0);
    git("init", "--quiet", directory);
    expect(git("rev-parse", "--absolute-git-dir")).toBe(path.join(directory, ".git"));
    const placeholders = await prepare(git, directory);
    const calls = path.join(directory, "calls.log");
    const mise = path.join(directory, "mise");
    await writeFile(
      mise,
      `#!/bin/sh\necho "$*" >> "${calls}"\ncase "$*" in *install*) exit 3;; esac\n`,
    );
    await chmod(mise, 0o755);
    const body = script.replace(/\{(\d)\}/g, (_, index: string) => placeholders[index] ?? "");
    const result = spawnSync("sh", ["-c", body], { cwd: directory, encoding: "utf8", env });
    const log = await readFile(calls, "utf8").catch(() => "");
    return { status: result.status, calls: log.split("\n").filter(Boolean) };
  } finally {
    await rm(directory, { recursive: true, force: true });
    expect((await readFile(repositoryConfig)).equals(repositoryConfigBefore)).toBe(true);
  }
}

async function commitLockfileChange(
  git: (...args: string[]) => string,
  directory: string,
): Promise<[string, string]> {
  git("commit", "--quiet", "--allow-empty", "--message", "before");
  const before = git("rev-parse", "HEAD");
  await writeFile(path.join(directory, "pnpm-lock.yaml"), "changed\n");
  git("add", "pnpm-lock.yaml");
  git("commit", "--quiet", "--message", "after");
  return [before, git("rev-parse", "HEAD")];
}

// The dependency hooks run one shell script each. A stub `mise` fails the install, and the hook
// must stop there with a failing status instead of running the remaining steps.
describe("lefthook dependency hooks", () => {
  it("stops post-checkout at a failed install", async () => {
    const script = hooks["post-checkout"]!.jobs[0]!.run!;
    const result = await runWithFailingInstall(script, async (git, directory) => {
      const [before, after] = await commitLockfileChange(git, directory);
      return { "1": before, "2": after, "3": "1" };
    });

    expect(result.status).toBe(3);
    expect(result.calls).toEqual(["exec -- pnpm install --frozen-lockfile"]);
  });

  it("stops post-merge at a failed install", async () => {
    const script = hooks["post-merge"]!.jobs[0]!.run!;
    const result = await runWithFailingInstall(script, async (git, directory) => {
      const [before] = await commitLockfileChange(git, directory);
      git("update-ref", "ORIG_HEAD", before);
      return {};
    });

    expect(result.status).toBe(3);
    expect(result.calls).toEqual(["exec -- pnpm install --frozen-lockfile"]);
  });
});
