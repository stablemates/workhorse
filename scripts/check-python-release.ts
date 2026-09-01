import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkRelease } from "./check-release.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const releaseDirectory = path.join(repositoryRoot, "python", "dist");

async function run(
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? String(code)}`));
    });
  });
}

async function pythonVersion(): Promise<string> {
  const manifest = await readFile(path.join(repositoryRoot, "python", "pyproject.toml"), "utf8");
  const version = /^version = "([^"]+)"$/m.exec(manifest)?.[1];
  if (!version) throw new Error("python/pyproject.toml declares no project version");
  return version;
}

function releaseTag(version: string): string {
  const requested = process.argv[2];
  if (requested) return requested;
  if (process.env.GITHUB_REF_TYPE === "tag") {
    const githubTag = process.env.GITHUB_REF_NAME;
    if (!githubTag) throw new Error("GITHUB_REF_TYPE is tag but GITHUB_REF_NAME is missing");
    return githubTag;
  }
  return `python/v${version}`;
}

async function distributions(directory: string, version: string): Promise<readonly string[]> {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .toSorted();
  const names = files.filter((name) => name.endsWith(".whl") || name.endsWith(".tar.gz"));
  const unexpected = files.filter((name) => name !== ".gitignore" && !names.includes(name));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected files in the Python build output: ${unexpected.join(", ")}`);
  }
  const expected = [
    `stablemates_workhorse-${version}-py3-none-any.whl`,
    `stablemates_workhorse-${version}.tar.gz`,
  ].toSorted();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected exactly ${expected.join(", ")}; built ${names.join(", ") || "no distributions"}`,
    );
  }
  return names;
}

export async function checkPythonRelease(): Promise<void> {
  const version = await pythonVersion();
  await checkRelease("python", releaseTag(version));

  await run("pnpm", ["dashboard-bundle:check"]);
  await run("pnpm", ["python:format:check"]);
  await run("pnpm", ["python:lint"]);
  await run("pnpm", ["python:vuln"]);
  await run("pnpm", ["python:typecheck"]);
  await run("pnpm", ["dashboard-bundle:fetch"]);

  const temporary = await mkdtemp(path.join(tmpdir(), "workhorse-python-release-"));
  const stagedDistributions = path.join(temporary, "dist");
  try {
    await run("uv", ["build", "--project", "python", "--out-dir", stagedDistributions]);
    const names = await distributions(stagedDistributions, version);
    await run("pnpm", ["python:test"], {
      WORKHORSE_PYTHON_DISTRIBUTIONS: stagedDistributions,
    });

    await rm(releaseDirectory, { force: true, recursive: true });
    await mkdir(releaseDirectory, { recursive: true });
    await Promise.all(
      names.map((name) =>
        cp(path.join(stagedDistributions, name), path.join(releaseDirectory, name)),
      ),
    );
    process.stdout.write(`Verified Python ${version} and wrote ${names.join(", ")}\n`);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await checkPythonRelease();
}
