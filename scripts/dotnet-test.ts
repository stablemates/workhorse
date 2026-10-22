/**
 * Run each .NET test project in order, with the same extra arguments.
 *
 * xUnit v3 makes each test project an executable, and `dotnet run --project` starts one project
 * only. CI passes arguments such as `--property:RollForward=LatestMajor`, and every project must
 * get them. The script stops at the first project that fails and exits with its code.
 *
 * Usage: tsx scripts/with-env.ts tsx scripts/dotnet-test.ts [dotnet run arguments]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The .NET test projects, in the order they run. Add a project here when a package adds one. */
export const DOTNET_TEST_PROJECTS = [
  "dotnet/tests/Workhorse.Tests",
  "dotnet/tests/Workhorse.AspNetCore.Tests",
] as const;

const repository = path.resolve(import.meta.dirname, "..");

/** The `dotnet` arguments for one project. */
export function dotnetRunArguments(project: string, extra: readonly string[]): string[] {
  return ["run", "--project", project, ...extra];
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
