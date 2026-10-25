/**
 * Pack and check the four .NET packages, then run the release consumer from a local feed.
 *
 * ADR 0107 publishes `Workhorse`, `Workhorse.Hosting`, `Workhorse.EntityFrameworkCore`, and
 * `Workhorse.AspNetCore` to nuget.org with the train version of `dotnet/Directory.Build.props`.
 * `dotnet pack` of the solution writes them with their symbol packages. This check then refuses the
 * output if one of these is true:
 *
 * 1. A package version differs from `dotnet/Directory.Build.props`, or from the `--tag` version.
 * 2. The output holds a file other than the four `.nupkg` files and their four `.snupkg` files. A
 *    demo, example, tool, consumer, or test project packs nothing, because it sets `IsPackable`
 *    to false.
 * 3. A nuspec lacks the license expression `Apache-2.0`, the README, the project URL, a description,
 *    or the repository URL and the commit that the check builds.
 * 4. A dependency on another Workhorse package names a version other than the train version.
 * 5. A package lacks its README, its assembly, or its documentation file for `net10.0`, or it holds
 *    another target framework.
 * 6. A symbol package lacks its PDB, the PDB has no SourceLink map to the commit, or the PDB names a
 *    path in the checkout. The build sets `ContinuousIntegrationBuild`, so a deterministic PDB names
 *    each source file under `/_/`.
 *
 * Package validation runs in `dotnet pack` (ADR 0107, "Governed surface and release"). Before the
 * first publish nuget.org has no version of the packages, so the check packs without a baseline and
 * package validation checks each package against its own target framework. After the first publish,
 * the check sets `PackageValidationBaselineVersion` to the newest published version below the train
 * version, and package validation fails on a breaking change from it. All four packages publish
 * together, so the check refuses packages whose newest published versions differ. `--baseline`
 * gives the version, or `none`, and the check then reads nothing from nuget.org.
 *
 * Unless `--no-consumers` is set, the check then restores `dotnet/release-consumer` in a temporary
 * directory. Its `nuget.config` takes the four packages only from the output directory and every
 * other package from nuget.org, and the restore uses an empty package folder. The consumer prints
 * the informational version of each package assembly. With a test database, it also enqueues one
 * task into a scratch database and runs it through the hosted worker of `Workhorse.Hosting`, and
 * the check reads that row back.
 *
 * The check publishes nothing and reads no secret. `--output <directory>` keeps the packages, so the
 * `nuget` job of `.github/workflows/release.yml` pushes the files that the consumer ran.
 *
 * Usage: tsx scripts/with-env.ts tsx scripts/check-dotnet-release.ts [--tag vX.Y.Z]
 *          [--baseline <version>|none] [--output <directory>] [--no-consumers]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { inflateRawSync } from "node:zlib";
import type { Client } from "pg";
import { tagVersion } from "./check-jvm-release.js";
import { withReleaseScratchDatabase } from "./release-scratch-database.js";

const root = path.resolve(import.meta.dirname, "..");
const dotnetDirectory = path.join(root, "dotnet");
const solution = path.join(dotnetDirectory, "Workhorse.slnx");
const consumerDirectory = path.join(dotnetDirectory, "release-consumer");
const targetFramework = "net10.0";
const repositoryUrl = "https://github.com/stablemates/workhorse";
const sourceLinkPrefix = "https://raw.githubusercontent.com/stablemates/workhorse/";
const nugetFlatContainer = "https://api.nuget.org/v3-flatcontainer";
const consumerQueue = "release-consumer";
const consumerTaskType = "release.consumer";

/** The four packages of ADR 0107, in the order that they publish. Nothing else may pack. */
export const publishedPackages = [
  "Workhorse",
  "Workhorse.Hosting",
  "Workhorse.EntityFrameworkCore",
  "Workhorse.AspNetCore",
] as const;

function run(
  command: string,
  args: readonly string[],
  options: { capture?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    // The checkout is the working directory, so the dotnet that mise.toml pins runs each command.
    const child = spawn(command, [...args], {
      cwd: root,
      env: options.env ?? process.env,
      stdio: ["ignore", options.capture ? "pipe" : "inherit", options.capture ? "pipe" : "inherit"],
    });
    let output = "";
    let errors = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              `${command} ${args.slice(0, 2).join(" ")} exited with ${signal ?? String(code)}${output || errors ? `\n${output}${errors}` : ""}`,
            ),
          ),
    );
  });
}

/** The train version that every .NET package carries. */
export function dotnetTrainVersion(buildProps: string): string {
  const version = /<Version>([^<]+)<\/Version>/.exec(buildProps)?.[1]?.trim();
  if (!version) throw new Error("dotnet/Directory.Build.props declares no Version");
  return version;
}

function semverParts(version: string): { core: number[]; prerelease: string[] } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error(`${version} is not a SemVer version`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

/** Compares two SemVer 2.0 versions. The result is negative, zero, or positive. */
export function compareVersions(left: string, right: string): number {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index++) {
    const difference = a.core[index]! - b.core[index]!;
    if (difference !== 0) return difference;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numeric = /^\d+$/;
    if (numeric.test(x) && numeric.test(y)) return Number(x) - Number(y);
    if (numeric.test(x) !== numeric.test(y)) return numeric.test(x) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The baseline of package validation: the newest published version below the train version, or
 * `undefined` before the first publish. `published` maps each package ID to its published
 * versions. The four packages publish together, so their baselines must agree.
 */
export function packageBaseline(
  published: ReadonlyMap<string, readonly string[]>,
  version: string,
): string | undefined {
  const baselines = publishedPackages.map((id) => {
    const earlier = (published.get(id) ?? []).filter(
      (candidate) => compareVersions(candidate, version) < 0,
    );
    return earlier.toSorted(compareVersions).at(-1);
  });
  if (new Set(baselines).size > 1) {
    throw new Error(
      `The newest published versions below ${version} differ: ${publishedPackages
        .map((id, index) => `${id} ${baselines[index] ?? "none"}`)
        .join(", ")}`,
    );
  }
  return baselines[0];
}

/** The versions nuget.org serves for one package ID. A package that does not exist has none. */
async function nugetVersions(id: string): Promise<string[]> {
  const response = await fetch(`${nugetFlatContainer}/${id.toLowerCase()}/index.json`);
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`nuget.org answered ${response.status} for the versions of ${id}`);
  }
  const body = (await response.json()) as { versions?: unknown };
  if (!Array.isArray(body.versions) || body.versions.some((value) => typeof value !== "string")) {
    throw new Error(`nuget.org wrote no version list for ${id}`);
  }
  return body.versions as string[];
}

/** The problems with the file list of the output directory. */
export function packageFileProblems(files: readonly string[], version: string): string[] {
  const expected = publishedPackages.flatMap((id) => [
    `${id}.${version}.nupkg`,
    `${id}.${version}.snupkg`,
  ]);
  const present = new Set(files);
  return [
    ...expected.filter((file) => !present.has(file)).map((file) => `${file} is missing`),
    ...files
      .filter((file) => !expected.includes(file))
      .map((file) => `${file} is not a file of the four packages at ${version}`),
  ];
}

/** Reads every file of a zip archive, such as a `.nupkg` file. */
export function readZip(archive: Buffer): Map<string, Buffer> {
  const endSignature = 0x06054b50;
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== endSignature) end--;
  if (end < 0) throw new Error("The archive has no end of central directory record");
  const count = archive.readUInt16LE(end + 10);
  let entry = archive.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(entry) !== 0x02014b50) {
      throw new Error("The archive has a bad central directory entry");
    }
    const method = archive.readUInt16LE(entry + 10);
    const compressedSize = archive.readUInt32LE(entry + 20);
    const nameLength = archive.readUInt16LE(entry + 28);
    const extraLength = archive.readUInt16LE(entry + 30);
    const commentLength = archive.readUInt16LE(entry + 32);
    const local = archive.readUInt32LE(entry + 42);
    const name = archive.toString("utf8", entry + 46, entry + 46 + nameLength);
    const dataStart =
      local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    if (method !== 0 && method !== 8) {
      throw new Error(`${name} uses compression method ${method}`);
    }
    if (!name.endsWith("/")) files.set(name, method === 8 ? inflateRawSync(data) : data);
    entry += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function element(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(xml)?.[1]?.trim();
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/** The problems with the nuspec of one package. */
export function nuspecProblems(
  id: string,
  nuspec: string,
  version: string,
  commit: string,
): string[] {
  const problems: string[] = [];
  const expect = (field: string, actual: string | undefined, wanted: string) => {
    if (actual !== wanted) {
      problems.push(`${id}: the nuspec ${field} is ${actual ?? "missing"}, not ${wanted}`);
    }
  };
  expect("id", element(nuspec, "id"), id);
  expect("version", element(nuspec, "version"), version);
  expect("readme", element(nuspec, "readme"), "README.md");
  expect("projectUrl", element(nuspec, "projectUrl"), "https://workhorse.run/");
  const license = /<license\s[^>]*>[^<]*<\/license>/.exec(nuspec)?.[0] ?? "";
  expect("license type", attribute(license, "type"), "expression");
  expect("license", element(nuspec, "license"), "Apache-2.0");
  if (!element(nuspec, "description")) problems.push(`${id}: the nuspec has no description`);
  const repository = /<repository\s[^>]*\/?>/.exec(nuspec)?.[0] ?? "";
  expect("repository url", attribute(repository, "url"), repositoryUrl);
  expect("repository commit", attribute(repository, "commit"), commit);

  const groups = [...nuspec.matchAll(/<group\s[^>]*targetFramework="([^"]+)"/g)].map(
    (match) => match[1],
  );
  for (const group of groups) {
    if (group !== targetFramework) {
      problems.push(`${id}: the nuspec has a dependency group for ${group}`);
    }
  }
  for (const dependency of nuspec.matchAll(/<dependency\s[^>]*\/>/g)) {
    const dependencyId = attribute(dependency[0], "id") ?? "";
    if (!dependencyId.startsWith("Workhorse")) continue;
    if (!(publishedPackages as readonly string[]).includes(dependencyId)) {
      problems.push(`${id}: the nuspec depends on ${dependencyId}, which is not a package`);
    }
    expect(`dependency on ${dependencyId}`, attribute(dependency[0], "version"), version);
  }
  return problems;
}

/** The problems with the files of one package. */
export function packageContentProblems(id: string, entries: readonly string[]): string[] {
  const required = [
    "README.md",
    `${id}.nuspec`,
    `lib/${targetFramework}/${id}.dll`,
    `lib/${targetFramework}/${id}.xml`,
  ];
  return [
    ...required
      .filter((file) => !entries.includes(file))
      .map((file) => `${id}: the package lacks ${file}`),
    ...entries
      .filter((file) => file.startsWith("lib/") && !required.includes(file))
      .map((file) => `${id}: the package holds ${file}`),
  ];
}

/** The problems with the PDB of one symbol package. */
export function symbolProblems(
  id: string,
  pdb: Buffer | undefined,
  commit: string,
  checkout: string,
): string[] {
  if (!pdb) return [`${id}: the symbol package lacks lib/${targetFramework}/${id}.pdb`];
  const text = pdb.toString("latin1");
  const problems: string[] = [];
  if (!text.includes(`"/_/*":"${sourceLinkPrefix}${commit}/*"`)) {
    problems.push(`${id}: the PDB has no SourceLink map to ${commit}`);
  }
  if (text.includes(checkout)) {
    problems.push(
      `${id}: the PDB names the checkout ${checkout}, so the build is not deterministic`,
    );
  }
  return problems;
}

/** The Npgsql connection string of a `postgres://` URL. */
export function connectionString(url: string): string {
  const parsed = new URL(url);
  const parts: [string, string][] = [
    ["Host", decodeURIComponent(parsed.hostname)],
    ["Port", parsed.port || "5432"],
    ["Database", decodeURIComponent(parsed.pathname.slice(1))],
  ];
  if (parsed.username) parts.push(["Username", decodeURIComponent(parsed.username)]);
  if (parsed.password) parts.push(["Password", decodeURIComponent(parsed.password)]);
  return parts.map(([key, value]) => `${key}='${value.replaceAll("'", "''")}'`).join(";");
}

/** The `nuget.config` that takes the four packages only from the local feed. */
export function consumerNugetConfig(feed: string): string {
  const value = feed.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="workhorse-release" value="${value}" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />
  </packageSources>
  <packageSourceMapping>
    <packageSource key="workhorse-release">
      <package pattern="Workhorse" />
      <package pattern="Workhorse.*" />
    </packageSource>
    <packageSource key="nuget.org">
      <package pattern="*" />
    </packageSource>
  </packageSourceMapping>
</configuration>
`;
}

/** The line the consumer prints first: the informational version of each package assembly. */
export function consumerVersionLine(version: string): string {
  return publishedPackages.map((id) => `${id}=${version}`).join(" ");
}

/** A scratch name `pnpm db:sweep` recognizes: the source name, a tag, and a ten-digit digest. */
export function scratchDatabaseName(source: string, pid: number): string {
  const digest = createHash("sha256").update(`dotnet-release:${pid}`).digest("hex");
  return `${source.slice(0, 44)}_gc_${digest.slice(0, 10)}`;
}

function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL_TEST_PACKED;
  if (url) return url;
  if (process.env.CI || process.env.WORKHORSE_REQUIRE_DATABASE === "1") {
    throw new Error("The .NET release check needs DATABASE_URL_TEST or DATABASE_URL_TEST_PACKED");
  }
  return undefined;
}

/** Creates a scratch database with the current schema, and drops it after `use` ends. */
async function withScratchDatabase(
  sourceUrl: string,
  use: (scratchUrl: string, database: Client) => Promise<void>,
): Promise<void> {
  const source = decodeURIComponent(new URL(sourceUrl).pathname.slice(1));
  await withReleaseScratchDatabase(sourceUrl, scratchDatabaseName(source, process.pid), use);
}

/** Reads back the task the consumer reports, and refuses it unless its handler echoed the payload. */
async function requireConsumerTask(database: Client, taskId: string): Promise<void> {
  const { rows } = await database.query<{
    queue_name: string;
    task_type: string;
    state: string | null;
    packaged: boolean | null;
  }>(
    `SELECT task.queue_name, task.task_type, outcome.state,
            (outcome.result -> 'echo' ->> 'packaged')::boolean AS packaged
       FROM workhorse.task task
       LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
      WHERE task.id = $1::uuid`,
    [taskId],
  );
  const row = rows[0];
  if (row?.queue_name !== consumerQueue || row.task_type !== consumerTaskType) {
    throw new Error(`The .NET consumer reported task ${taskId}, but no matching row exists`);
  }
  if (row.state !== "succeeded" || row.packaged !== true) {
    throw new Error(`The .NET consumer left task ${taskId} in state ${row.state}`);
  }
}

/** Restores the consumer from the feed, checks where each package came from, and runs it. */
async function runConsumer(version: string, feed: string, temporary: string): Promise<void> {
  const url = databaseUrl();
  const directory = path.join(temporary, "consumer");
  await cp(consumerDirectory, directory, {
    recursive: true,
    filter: (source) => !["bin", "obj"].includes(path.basename(source)),
  });
  const config = path.join(directory, "nuget.config");
  await writeFile(config, consumerNugetConfig(feed));
  const packages = path.join(temporary, "packages");
  const environment = { ...process.env, NUGET_PACKAGES: packages };
  const project = path.join(directory, "ReleaseConsumer.csproj");
  const versionProperty = `-p:WorkhorseVersion=${version}`;

  await run("dotnet", ["restore", project, "--configfile", config, versionProperty], {
    env: environment,
  });
  for (const id of publishedPackages) {
    const metadata = path.join(packages, id.toLowerCase(), version, ".nupkg.metadata");
    const source = (JSON.parse(await readFile(metadata, "utf8")) as { source?: string }).source;
    if (path.resolve(source ?? "") !== path.resolve(feed)) {
      throw new Error(`The consumer restored ${id} ${version} from ${source}, not ${feed}`);
    }
  }
  const consume = async (args: readonly string[]) =>
    (
      await run(
        "dotnet",
        [
          "run",
          "--project",
          project,
          "--no-restore",
          "-c",
          "Release",
          versionProperty,
          ...(args.length ? ["--", ...args] : []),
        ],
        { capture: true, env: environment },
      )
    )
      .trim()
      .split("\n");
  const expectedVersions = consumerVersionLine(version);
  const requireVersions = (line: string | undefined) => {
    if (line?.trim() !== expectedVersions) {
      throw new Error(`The .NET consumer loaded ${line}, not ${expectedVersions}`);
    }
  };

  if (!url) {
    requireVersions((await consume([]))[0]);
    console.log("SKIPPED the .NET consumer task: DATABASE_URL_TEST is unset");
    return;
  }
  await withScratchDatabase(url, async (scratchUrl, database) => {
    const lines = await consume([connectionString(scratchUrl)]);
    requireVersions(lines[0]);
    const taskId = lines.at(-1)?.trim() ?? "";
    await requireConsumerTask(database, taskId);
    console.log(`The .NET consumer restored the four packages ${version} and ran task ${taskId}`);
  });
}

export async function checkDotnetRelease(options: {
  readonly tag?: string;
  /** A version, `none`, or `undefined` to read the baseline from nuget.org. */
  readonly baseline?: string;
  readonly output?: string;
  readonly consumers: boolean;
}): Promise<void> {
  const version = dotnetTrainVersion(
    await readFile(path.join(dotnetDirectory, "Directory.Build.props"), "utf8"),
  );
  if (options.tag !== undefined && tagVersion(options.tag) !== version) {
    throw new Error(
      `dotnet/Directory.Build.props is ${version} but the tag is ${tagVersion(options.tag)}`,
    );
  }
  const commit = (await run("git", ["rev-parse", "HEAD"], { capture: true })).trim();
  const baseline =
    options.baseline === "none"
      ? undefined
      : (options.baseline ??
        packageBaseline(
          new Map(
            await Promise.all(
              publishedPackages.map(async (id) => [id, await nugetVersions(id)] as const),
            ),
          ),
          version,
        ));
  if (baseline !== undefined && compareVersions(baseline, version) >= 0) {
    throw new Error(`The baseline ${baseline} is not below the train version ${version}`);
  }

  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "workhorse-dotnet-release-")));
  try {
    const feed = path.resolve(options.output ?? path.join(temporary, "feed"));
    await rm(feed, { recursive: true, force: true });
    await mkdir(feed, { recursive: true });
    const properties = [
      "-c",
      "Release",
      "-p:ContinuousIntegrationBuild=true",
      ...(baseline === undefined ? [] : [`-p:PackageValidationBaselineVersion=${baseline}`]),
    ];
    // A full build first, so no assembly of an earlier build without these settings is packed.
    // The restore of the build downloads the baseline that package validation reads in the pack.
    await run("dotnet", ["build", solution, "--no-incremental", ...properties]);
    await run("dotnet", ["pack", solution, "--no-build", "-o", feed, ...properties]);

    const files = (await readdir(feed)).toSorted();
    const problems = packageFileProblems(files, version);
    if (problems.length === 0) {
      for (const id of publishedPackages) {
        const contents = readZip(await readFile(path.join(feed, `${id}.${version}.nupkg`)));
        problems.push(
          ...packageContentProblems(id, [...contents.keys()]),
          ...nuspecProblems(
            id,
            contents.get(`${id}.nuspec`)?.toString("utf8") ?? "",
            version,
            commit,
          ),
        );
        const symbols = readZip(await readFile(path.join(feed, `${id}.${version}.snupkg`)));
        problems.push(
          ...symbolProblems(id, symbols.get(`lib/${targetFramework}/${id}.pdb`), commit, root),
        );
      }
    }
    if (problems.length > 0) throw new Error(problems.join("\n"));
    console.log(
      `Packed and checked ${publishedPackages.join(", ")} ${version} at ${commit}, with package validation ${
        baseline === undefined ? "without a baseline" : `against ${baseline}`
      }`,
    );

    if (options.consumers) await runConsumer(version, feed, temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      baseline: { type: "string" },
      output: { type: "string" },
      "no-consumers": { type: "boolean", default: false },
    },
  });
  await checkDotnetRelease({
    tag: values.tag,
    baseline: values.baseline,
    output: values.output,
    consumers: !values["no-consumers"],
  });
}
