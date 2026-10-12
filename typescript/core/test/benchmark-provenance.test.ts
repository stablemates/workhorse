import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureBenchmarkProvenance } from "../benchmarks/run.js";

// Each case builds a throwaway repository with the monorepo layout, so the result does not depend
// on the state of the checkout that runs the test. Git variables that a hook sets would point Git
// at that checkout, and global or system configuration can add hooks or ignore rules. The test
// removes both for the fixture commands and for the code under test.

function git(cwd: string, ...arguments_: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Benchmark Provenance Test",
      "-c",
      "user.email=provenance@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...arguments_,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

describe("captureBenchmarkProvenance source state", () => {
  let repository: string;
  let packageDirectory: string;

  async function write(relativePath: string, content: string): Promise<void> {
    const file = path.join(repository, relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  beforeEach(async () => {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("GIT_")) vi.stubEnv(name, undefined);
    }
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    repository = await mkdtemp(path.join(tmpdir(), "workhorse-benchmark-provenance-"));
    packageDirectory = path.join(repository, "typescript", "core");
    git(repository, "init", "--quiet");
    await write(".gitignore", "benchmark*.json\n");
    await write("README.md", "readme\n");
    await write("sql/schema/001.sql", "select 1;\n");
    await write("typescript/core/package.json", "{}\n");
    await write("typescript/core/benchmarks/scenarios.ts", "export const value = 1;\n");
    await write("typescript/core/src/index.ts", "export {};\n");
    git(repository, "add", "--all");
    git(repository, "commit", "--quiet", "--message", "initial");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(repository, { recursive: true, force: true });
  });

  it("records a clean checkout as not dirty", () => {
    const { source } = captureBenchmarkProvenance(packageDirectory);
    expect(source).toEqual({ commit: git(repository, "rev-parse", "HEAD"), dirty: false });
  });

  it("records an uncommitted change under typescript/core/benchmarks as dirty", async () => {
    await write("typescript/core/benchmarks/scenarios.ts", "export const value = 2;\n");
    expect(captureBenchmarkProvenance(packageDirectory).source.dirty).toBe(true);
  });

  it("records an untracked benchmark module as dirty", async () => {
    await write("typescript/core/benchmarks/new-scenario.ts", "export {};\n");
    expect(captureBenchmarkProvenance(packageDirectory).source.dirty).toBe(true);
  });

  it("records an uncommitted change to the repository-root schema as dirty", async () => {
    await write("sql/schema/001.sql", "select 2;\n");
    expect(captureBenchmarkProvenance(packageDirectory).source.dirty).toBe(true);
  });

  it("ignores result artifacts and files outside the benchmark sources", async () => {
    await write("benchmark-report.json", "{}\n");
    await write("typescript/core/benchmark-smoke.json", "{}\n");
    await write("README.md", "changed\n");
    await write("notes.txt", "untracked\n");
    expect(captureBenchmarkProvenance(packageDirectory).source.dirty).toBe(false);
  });
});
