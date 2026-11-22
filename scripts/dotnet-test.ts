/**
 * Run each .NET test project in order, with the same extra arguments.
 *
 * xUnit v3 makes each test project an executable, and `dotnet run --project` starts one project
 * only. CI passes arguments such as `--property:RollForward=LatestMajor`, and every project must
 * get them. The script stops at the first project that fails and exits with its code.
 *
 * xUnit runs one test class for each processor at the same time, and many classes open a scratch
 * database and a pool. On a host with 32 processors the suite used 95 of the 100 PostgreSQL
 * connections, and tests failed with "remaining connection slots are reserved". The script gives
 * each test program `-maxThreads` with the number of processors, but at most 8. The limit never
 * raises the number, because a CI runner has 2 processors, and the timing tests need that load.
 *
 * Usage: tsx scripts/with-env.ts tsx scripts/dotnet-test.ts [dotnet run arguments] [-- test arguments]
 */
import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The .NET test projects, in the order they run. Add a project here when a package adds one. */
export const DOTNET_TEST_PROJECTS = [
  "dotnet/tests/Workhorse.Tests",
  "dotnet/tests/Workhorse.AspNetCore.Tests",
  "dotnet/examples/Workhorse.Examples.Tests",
  "dotnet/examples/Workhorse.Examples.Programs.Tests",
] as const;

const repository = path.resolve(import.meta.dirname, "..");

/** The number of test classes that xUnit runs at the same time: the processors, but at most 8. */
export function testThreads(processors = availableParallelism()): number {
  return Math.min(processors, 8);
}

/**
 * The `dotnet` arguments for one project. The arguments after `--` go to the test program, after
 * the thread limit. A `-maxThreads` of the caller replaces the limit.
 */
export function dotnetRunArguments(
  project: string,
  extra: readonly string[],
  threads = testThreads(),
): string[] {
  const separator = extra.indexOf("--");
  const dotnet = separator === -1 ? extra : extra.slice(0, separator);
  const program = separator === -1 ? [] : extra.slice(separator + 1);
  const limit = program.includes("-maxThreads") ? [] : ["-maxThreads", String(threads)];
  return ["run", "--project", project, ...dotnet, "--", ...limit, ...program];
}

function main(): void {
  const extra = process.argv.slice(2);
  for (const project of DOTNET_TEST_PROJECTS) {
    const result = spawnSync("dotnet", dotnetRunArguments(project, extra), {
      cwd: repository,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(`${project} failed`);
      process.exit(result.status ?? 1);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
