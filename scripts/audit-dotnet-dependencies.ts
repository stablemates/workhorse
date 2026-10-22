import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

// `pnpm dotnet:vuln` scans the packages that a caller of the four .NET packages resolves (ADR 0107,
// "Floors"). NuGet resolves the lowest version that a range allows, so a caller who asks for
// nothing more gets each floor of `dotnet/Directory.Packages.props`. The floor consumer in
// `dotnet/floor-consumer/` references the four packages and nothing else.
//
// Every restore of the solution already runs NuGet Audit, with each finding as an error. This scan
// adds three checks that a restore does not make:
//
// 1. The consumer resolves each shipped dependency at its floor. A resolution above a floor would
//    scan a version that a caller does not get.
// 2. `dotnet list package --vulnerable --include-transitive` reports no advisory for any package of
//    the consumer, whatever its severity.
// 3. The listing names nuget.org as its advisory source. A listing without a source reports no
//    advisory, so it cannot show a clean graph.
//
// The consumer makes NU1900 an error, so a restore that cannot load the advisory data fails too.

const execFileAsync = promisify(execFile);

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const consumer = "dotnet/floor-consumer/FloorConsumer.csproj";
const advisorySource = "https://api.nuget.org/v3/index.json";

/** One package of the consumer's graph, as `dotnet list package --format json` reports it. */
export interface ListedPackage {
  readonly id: string;
  readonly resolvedVersion: string;
  readonly vulnerabilities: readonly { readonly severity: string; readonly advisoryUrl: string }[];
}

/** The parts of a `dotnet list package --format json` report that the scan reads. */
export interface PackageReport {
  readonly sources: readonly string[];
  readonly packages: readonly ListedPackage[];
  readonly problems: readonly string[];
}

/** The shipped dependencies and their floors, from the `Shipped dependencies` item group. */
export function shippedFloors(packagesProps: string): ReadonlyMap<string, string> {
  const start = packagesProps.indexOf('<ItemGroup Label="Shipped dependencies">');
  const end = packagesProps.indexOf("</ItemGroup>", start);
  if (start < 0 || end < 0) {
    throw new Error("dotnet/Directory.Packages.props has no Shipped dependencies item group");
  }
  const floors = new Map(
    [
      ...packagesProps
        .slice(start, end)
        .matchAll(/<PackageVersion Include="([^"]+)" Version="([^"]+)" \/>/g),
    ].map((match) => [match[1]!, match[2]!]),
  );
  if (floors.size === 0) throw new Error("dotnet/Directory.Packages.props lists no floor");
  return floors;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`dotnet list package wrote ${what} that is not an object`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, what: string): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error(`dotnet list package wrote ${what} that is not a list`);
  return value;
}

/** Reads the JSON report of `dotnet list package --format json`, with or without `--vulnerable`. */
export function parsePackageReport(output: string): PackageReport {
  const report = record(JSON.parse(output), "a report");
  if (report.version !== 1) {
    throw new Error(`dotnet list package wrote report version ${String(report.version)}, not 1`);
  }
  const problems = list(report.problems, "problems").map((problem) => {
    const entry = record(problem, "a problem");
    return `${String(entry.level ?? "problem")}: ${String(entry.text ?? JSON.stringify(entry))}`;
  });
  const packages = list(report.projects, "projects").flatMap((project) =>
    list(record(project, "a project").frameworks, "frameworks").flatMap((framework) => {
      const entry = record(framework, "a framework");
      return [
        ...list(entry.topLevelPackages, "top-level packages"),
        ...list(entry.transitivePackages, "transitive packages"),
      ].map((listed): ListedPackage => {
        const item = record(listed, "a package");
        return {
          id: String(item.id),
          resolvedVersion: String(item.resolvedVersion),
          vulnerabilities: list(item.vulnerabilities, "vulnerabilities").map((vulnerability) => {
            const finding = record(vulnerability, "a vulnerability");
            return {
              severity: String(finding.severity),
              advisoryUrl: String(finding.advisoryurl ?? finding.advisoryUrl),
            };
          }),
        };
      });
    }),
  );
  return {
    sources: list(report.sources, "sources").map(String),
    packages,
    problems,
  };
}

/** Each shipped dependency that the consumer does not resolve at its floor. */
export function floorProblems(
  floors: ReadonlyMap<string, string>,
  resolved: PackageReport,
): readonly string[] {
  const versions = new Map(resolved.packages.map((entry) => [entry.id, entry.resolvedVersion]));
  return [...floors].flatMap(([id, floor]) => {
    const version = versions.get(id);
    if (version === undefined) return [`${consumer} does not resolve ${id}`];
    return version === floor
      ? []
      : [`${consumer} resolves ${id} ${version}, not its floor ${floor}`];
  });
}

/** Each advisory of the vulnerable listing, and each reason that the listing cannot be trusted. */
export function advisoryProblems(vulnerable: PackageReport): readonly string[] {
  const problems = [...vulnerable.problems];
  if (!vulnerable.sources.includes(advisorySource)) {
    problems.push(`the listing did not read the advisories of ${advisorySource}`);
  }
  for (const entry of vulnerable.packages) {
    for (const finding of entry.vulnerabilities) {
      problems.push(
        `${entry.id} ${entry.resolvedVersion} has a ${finding.severity} advisory: ${finding.advisoryUrl}`,
      );
    }
  }
  return problems;
}

async function dotnet(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("dotnet", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `dotnet ${args.join(" ")} failed:\n${failed.stdout ?? ""}${failed.stderr ?? failed.message}`,
      { cause: error },
    );
  }
}

async function scan(): Promise<readonly string[]> {
  const floors = shippedFloors(
    await readFile(path.join(repositoryRoot, "dotnet/Directory.Packages.props"), "utf8"),
  );
  // `--force` makes NuGet resolve the graph again, so the audit runs on every scan.
  await dotnet("restore", consumer, "--force");
  const resolved = parsePackageReport(
    await dotnet("list", consumer, "package", "--include-transitive", "--format", "json"),
  );
  const vulnerable = parsePackageReport(
    await dotnet(
      "list",
      consumer,
      "package",
      "--vulnerable",
      "--include-transitive",
      "--format",
      "json",
    ),
  );
  return [
    ...resolved.problems,
    ...floorProblems(floors, resolved),
    ...advisoryProblems(vulnerable),
  ];
}

async function main(): Promise<void> {
  let problems: readonly string[];
  try {
    problems = await scan();
  } catch (error) {
    // A failed restore is the NuGet Audit finding itself, or advisory data that did not load.
    problems = [error instanceof Error ? error.message : String(error)];
  }
  if (problems.length > 0) {
    process.stderr.write(`The .NET dependency scan failed:\n- ${problems.join("\n- ")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("No advisory affects a package that the floor consumer resolves.\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
