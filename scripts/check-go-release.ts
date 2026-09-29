/**
 * Rehearse the Go module release against the commit about to be tagged.
 *
 * A Go module has no artifact to build: the tag itself publishes it. The rehearsal therefore stages
 * a file module proxy that serves `HEAD:go` under the requested version, exactly as
 * proxy.golang.org would serve the tag, and runs the post-publish check against it. A check the
 * module cannot satisfy fails here instead of after `go/v*` is pushed.
 *
 * The zip drops directory entries because the module zip format has none; with them, `go mod
 * verify` reports the extracted module as modified.
 *
 * Usage: pnpm go:release-check X.Y.Z, or `pnpm go:package-check` for the module zip alone.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkRelease } from "./check-release.js";
import { verifyRelease } from "./verify-release.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const goModule = "github.com/stablemates/workhorse/go";

async function run(command: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? String(code)}`));
    });
  });
}

/** Write the four files a GOPROXY serves for one version of the module at `HEAD`. */
async function stageProxy(proxy: string, version: string): Promise<void> {
  const versions = path.join(proxy, ...goModule.split("/"), "@v");
  await mkdir(versions, { recursive: true });
  const tagged = `v${version}`;
  const time = (await run("git", ["show", "--no-patch", "--format=%cI", "HEAD"])).trim();
  await writeFile(path.join(versions, "list"), `${tagged}\n`);
  await writeFile(
    path.join(versions, `${tagged}.info`),
    JSON.stringify({ Version: tagged, Time: time }),
  );
  await writeFile(
    path.join(versions, `${tagged}.mod`),
    await run("git", ["show", "HEAD:go/go.mod"]),
  );
  const archive = path.join(versions, `${tagged}.zip`);
  await run("git", [
    "archive",
    "--format=zip",
    `--prefix=${goModule}@${tagged}/`,
    "--output",
    archive,
    "HEAD:go",
  ]);
  await run("zip", ["--delete", "--quiet", archive, "*/"]);
}

/**
 * The version the package check stages. Nothing publishes it, and the staged proxy answers for it
 * before proxy.golang.org is asked.
 */
const packageCheckVersion = "0.0.0-package-check";

/**
 * Serve the module at `HEAD` from a staged proxy and consume it from a clean module.
 *
 * It needs no release tag or changelog entry, so the weekly CI run can prove the module zip
 * between releases.
 */
export async function checkGoPackage(version = packageCheckVersion): Promise<void> {
  const proxy = await mkdtemp(path.join(tmpdir(), "workhorse-go-release-"));
  try {
    await stageProxy(proxy, version);
    await verifyRelease("go", version, { goProxy: proxy });
  } finally {
    await rm(proxy, { force: true, recursive: true });
  }
}

export async function checkGoRelease(version: string): Promise<void> {
  await checkRelease("go", `go/v${version}`);
  await checkGoPackage(version);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const argument = process.argv[2];
  if (!argument || process.argv.length > 3) {
    process.stderr.write("Usage: pnpm go:release-check X.Y.Z | pnpm go:package-check\n");
    process.exitCode = 64;
  } else if (argument === "--package") {
    await checkGoPackage();
  } else {
    await checkGoRelease(argument);
  }
}
