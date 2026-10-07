import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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
    expect(config).toContain("run: mise exec -- pnpm rust:test");
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
    expect(config).toContain("run: mise exec -- pnpm rust:conformance:check");
  });

  it("routes staged Ruby files to RuboCop and the generated catalogue to its check", () => {
    expect(config).toContain('glob: "ruby/**"');
    expect(config).toContain("run: mise exec -- pnpm ruby:lint");
    expect(config).toContain("ruby/lib/stablemates/workhorse/sql_catalogue_generated.rb}");
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
