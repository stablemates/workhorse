import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkRelease } from "./check-release.js";
import { publishedPackages } from "./packages.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const releaseDirectory = path.join(repositoryRoot, "dist-tarballs");

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

function releaseTag(version: string): string {
  const requested = process.argv[2];
  if (requested) return requested;
  if (process.env.GITHUB_REF_TYPE === "tag") {
    const githubTag = process.env.GITHUB_REF_NAME;
    if (!githubTag) throw new Error("GITHUB_REF_TYPE is tag but GITHUB_REF_NAME is missing");
    return githubTag;
  }
  return `v${version}`;
}

export async function checkNpmRelease(): Promise<void> {
  const packages = await publishedPackages();
  const version = packages[0]?.version;
  if (!version) throw new Error("No publishable npm packages were found");
  await checkRelease("npm", releaseTag(version));

  await run("pnpm", ["sql-catalogues:check"]);
  await run("pnpm", ["dashboard-spec:check"]);
  await run("pnpm", ["npm:lint"]);
  await run("pnpm", ["npm:typecheck"]);
  await run("pnpm", ["build:runtime:check-dashboard-bundle"]);
  await run("pnpm", ["test:build-check"]);
  await run("pnpm", ["npm:test:unit"]);

  const temporary = await mkdtemp(path.join(tmpdir(), "workhorse-npm-release-"));
  const stagedTarballs = path.join(temporary, "tarballs");
  try {
    await mkdir(stagedTarballs);
    for (const entry of packages) {
      await run("pnpm", [
        "--silent",
        "--dir",
        entry.location,
        "pack",
        "--pack-destination",
        stagedTarballs,
      ]);
    }
    const actual = (await readdir(stagedTarballs)).toSorted();
    const expected = packages.map((entry) => entry.tarball).toSorted();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Expected exactly ${expected.join(", ")}; built ${actual.join(", ") || "no tarballs"}`,
      );
    }

    await run("pnpm", ["db:reset:test-packed"]);
    await run("pnpm", ["npm:test:packed"], { WORKHORSE_NPM_TARBALLS: stagedTarballs });

    await rm(releaseDirectory, { force: true, recursive: true });
    await mkdir(releaseDirectory, { recursive: true });
    await Promise.all(
      expected.map((name) =>
        cp(path.join(stagedTarballs, name), path.join(releaseDirectory, name)),
      ),
    );
    process.stdout.write(`Verified npm ${version} and wrote ${expected.join(", ")}\n`);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await checkNpmRelease();
}
