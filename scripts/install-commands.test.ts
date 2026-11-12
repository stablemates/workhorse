import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { publishedPackages, repositoryRoot } from "./packages.js";

// A reader copies the first install command they see. Nine surfaces printing nine variants is how
// one of them keeps recommending a version nobody publishes any more, so support.json states each
// command once and this file is what makes a surface disagreeing with it a failure.
//
// Four of the governed surfaces are README files rendered by npm, PyPI, and pkg.go.dev. They are
// plain Markdown with no build step, so no component and no site generator can reach them; a text
// assertion can.
//
// The schema command is the exception to the no-version rule, and the exception is the whole point.
// An adoption command must name no version, because a reader who copies one pins the release they
// happened to read about. A pipeline command must name one: the schema tool has to match the SDK
// the application depends on, or the deploy fails on a schema the application will not accept
// ([ADR 0053](../docs/decisions/0053-start-migrations-at-0-1-0-and-keep-them-additive.md)).
//
// A TypeScript project needs no pin. `npm exec --no` runs the binary from `node_modules`, which is
// the application's own dependency, so the versions match by construction and `--no` refuses to
// fetch anything when it is absent. A Python, Go, Rust, or Ruby project has no `node_modules` to
// resolve from, so its command names the version explicitly, and the rule below is what keeps that
// literal equal to the version this repository publishes.
//
// A Gradle or Maven dependency is the other exception. Its coordinate has no form without a
// version, so `install.gradle` and `install.maven` name the version of `jvm/gradle.properties`, and
// a rule below holds them to it. They name the core, `run.workhorse:workhorse`. Maven Central serves
// the three artifacts from 0.9.0 (SM-1452), so the JVM README, the install pages, and
// `docs/compatibility.md` show them. A page that gives the command of the Kotlin module or the
// starter gives the core command with only the artifact ID changed, and a sweep below holds every
// JVM coordinate on every page to the version of `install.gradle`.
//
// A NuGet package needs no version: `dotnet add package` adds the newest release, so
// `install.dotnet` follows the no-version rule. It names the core, `Workhorse`. nuget.org serves
// the four packages from 0.10.0 (SM-1826), so the .NET README, the install pages, and
// `docs/compatibility.md` show it.

const execFileAsync = promisify(execFile);

type InstallCommand =
  | "dotnet"
  | "go"
  | "gradle"
  | "maven"
  | "node"
  | "python"
  | "ruby"
  | "rust"
  | "schema"
  | "schemaDownload"
  | "schemaPinned";

interface InstallManifest {
  readonly install: Readonly<Record<InstallCommand, string>>;
}

interface GovernedSurface {
  /** Path from the repository root. */
  readonly file: string;
  /** Commands a reader must be able to copy from this surface. */
  readonly commands: readonly InstallCommand[];
}

/**
 * Surfaces that tell a reader what to type.
 *
 * A surface is here because it introduces the product to someone who has not installed it. Pages
 * that mention a package in passing are covered by the no-version and bare-`npx` sweeps below
 * without having to carry a canonical command of their own.
 */
const governedSurfaces: readonly GovernedSurface[] = [
  { file: "typescript/core/README.md", commands: ["node", "schema"] },
  { file: "typescript/dashboard/README.md", commands: ["node"] },
  { file: "typescript/dashboard-server/README.md", commands: ["node"] },
  { file: "typescript/drizzle/README.md", commands: ["node"] },
  { file: "typescript/kysely/README.md", commands: ["node"] },
  { file: "typescript/knex/README.md", commands: ["node"] },
  { file: "typescript/otel/README.md", commands: ["node"] },
  { file: "typescript/prisma/README.md", commands: ["node"] },
  { file: "typescript/typeorm/README.md", commands: ["node"] },
  { file: "python/README.md", commands: ["python", "schemaPinned"] },
  { file: "go/README.md", commands: ["go", "schemaPinned"] },
  { file: "go/examples/README.md", commands: ["go"] },
  { file: "rust/README.md", commands: ["rust", "schemaPinned"] },
  { file: "ruby/README.md", commands: ["ruby", "schemaPinned"] },
  { file: "jvm/README.md", commands: ["gradle", "maven", "schemaPinned"] },
  { file: "dotnet/README.md", commands: ["dotnet", "schemaPinned"] },
  {
    file: "site/content/docs/installation.mdx",
    commands: [
      "dotnet",
      "go",
      "gradle",
      "maven",
      "node",
      "python",
      "ruby",
      "rust",
      "schema",
      "schemaDownload",
      "schemaPinned",
    ],
  },
  {
    file: "site/content/docs/quickstart.mdx",
    commands: [
      "dotnet",
      "go",
      "gradle",
      "maven",
      "node",
      "python",
      "ruby",
      "rust",
      "schema",
      "schemaPinned",
    ],
  },
  {
    file: "site/content/docs/for-ai-agents.mdx",
    commands: [
      "dotnet",
      "go",
      "gradle",
      "maven",
      "node",
      "python",
      "ruby",
      "rust",
      "schema",
      "schemaPinned",
    ],
  },
  {
    file: "docs/guides/385-agent-integration.md",
    commands: ["dotnet", "go", "gradle", "maven", "node", "python", "ruby", "rust"],
  },
  { file: "site/content/docs/api.mdx", commands: ["schema", "schemaPinned"] },
  { file: "docs/compatibility.md", commands: ["dotnet", "gradle", "maven"] },
];

/** The .NET packages that a project adds beside `Workhorse` when it uses them (ADR 0107). */
const optionalDotnetPackages = [
  "Workhorse.Hosting",
  "Workhorse.EntityFrameworkCore",
  "Workhorse.AspNetCore",
] as const;

/** The pages that list the four .NET packages with an install command for each. */
const dotnetPackagePages = ["dotnet/README.md", "site/content/docs/installation.mdx"] as const;

/** The artifact ID that `install.gradle` and `install.maven` name. */
const jvmCoreArtifact = "workhorse";

/** The JVM artifacts beside the core (ADR 0103), each with the pages that give its commands. */
const jvmModulePages = [
  {
    artifact: "workhorse-kotlin",
    files: [
      "jvm/README.md",
      "site/content/docs/installation.mdx",
      "site/content/docs/quickstart.mdx",
    ],
  },
  {
    artifact: "workhorse-spring-boot-starter",
    files: ["jvm/README.md", "site/content/docs/installation.mdx"],
  },
] as const;

/** Each page that gives a Java or Kotlin command, with the number of places that give one. */
const pgjdbcPages = [
  ["jvm/README.md", 1],
  ["site/content/docs/installation.mdx", 2],
  ["site/content/docs/quickstart.mdx", 2],
] as const;

/** The sentence that tells a reader to add PgJDBC, with the version that it names. */
const pgjdbcSentencePattern = /also add `org\.postgresql:postgresql` (\S+) or newer\./g;

/** Every artifact that Maven Central serves in the group `run.workhorse`. */
const jvmArtifacts: ReadonlySet<string> = new Set([
  jvmCoreArtifact,
  ...jvmModulePages.map((entry) => entry.artifact),
]);

/** A JVM dependency that a page states, split into the parts that a build resolves. */
interface JvmDependency {
  /** `prose` is a coordinate in a sentence, which can name an artifact without a version. */
  readonly kind: "prose" | "build";
  readonly text: string;
  readonly group: string;
  readonly artifact: string;
  readonly version: string | undefined;
}

/**
 * A Gradle coordinate in the group `run.workhorse`, in prose or in a build line. Neither part ends
 * in punctuation, so a full stop after a coordinate in a sentence stays outside it.
 */
const gradleCoordinatePattern = /run\.workhorse:[\w.-]*[\w-](?::[^\s"'`)]*[^\s"'`).,;:])?/g;

/** The string notation of a Gradle dependency, whatever its group. */
const gradleDependencyPattern =
  /\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\(?\s*["']([^"'\n]+)["']/g;

/**
 * The map notation of a Gradle dependency, `group: "…", name: "…", version: "…"` in the Groovy DSL
 * or `group = "…", name = "…", version = "…"` in the Kotlin DSL, in any order of its keys. A comma
 * separates two entries, and a line break can follow it.
 */
const gradleMapEntry = String.raw`\b(?:group|name|version)\s*[:=]\s*["'][^"'\n]*["']`;
const gradleMapPattern = new RegExp(
  String.raw`${gradleMapEntry}(?:\s*,\s*${gradleMapEntry}){1,2}`,
  "g",
);

function gradleMapValue(notation: string, key: string): string | undefined {
  return new RegExp(`\\b${key}\\s*[:=]\\s*["']([^"'\\n]*)["']`).exec(notation)?.[1];
}

/** One Maven dependency block, whatever its group and the order of its elements. */
const mavenDependencyPattern = /<dependency\s*>([\s\S]*?)<\/dependency\s*>/g;

function mavenElement(block: string, name: string): string | undefined {
  return new RegExp(`<${name}\\s*>\\s*([^<]*?)\\s*</${name}\\s*>`).exec(block)?.[1];
}

/**
 * Every Gradle coordinate and Maven dependency on a page that names the group `run.workhorse` or
 * an artifact ID that starts with `workhorse`. A wrong group or a missing version is thus still a
 * dependency that the sweep reads, not text that it skips.
 */
function jvmDependencies(contents: string): JvmDependency[] {
  const found: JvmDependency[] = [];
  const notations = [
    ...[...contents.matchAll(gradleCoordinatePattern)].map((match) => ["prose", match[0]] as const),
    ...[...contents.matchAll(gradleDependencyPattern)].flatMap((match) =>
      match[1] === undefined ? [] : [["build", match[1]] as const],
    ),
  ];
  for (const [kind, text] of notations) {
    const [group = "", artifact = "", version] = text.split(":");
    found.push({ kind, text, group, artifact, version });
  }
  for (const [text] of contents.matchAll(gradleMapPattern)) {
    found.push({
      kind: "build",
      text: text.trim(),
      group: gradleMapValue(text, "group") ?? "",
      artifact: gradleMapValue(text, "name") ?? "",
      version: gradleMapValue(text, "version"),
    });
  }
  for (const [text, block = ""] of contents.matchAll(mavenDependencyPattern)) {
    found.push({
      kind: "build",
      text: collapse(text),
      group: mavenElement(block, "groupId") ?? "",
      artifact: mavenElement(block, "artifactId") ?? "",
      version: mavenElement(block, "version"),
    });
  }
  return found.filter(
    (dependency) =>
      dependency.group === "run.workhorse" || /^workhorse(?:-|$)/.test(dependency.artifact),
  );
}

/** What is wrong with each JVM dependency in a page, against the version of `install.gradle`. */
function jvmDependencyErrors(contents: string, version: string): string[] {
  const wrong: string[] = [];
  for (const dependency of jvmDependencies(contents)) {
    const { text, group, artifact } = dependency;
    if (group !== "run.workhorse") wrong.push(`group ${group} in ${text}`);
    if (!jvmArtifacts.has(artifact)) wrong.push(`unknown artifact in ${text}`);
    if (dependency.version === undefined) {
      if (dependency.kind === "build") wrong.push(`no version in ${text}`);
    } else if (dependency.version !== version) {
      wrong.push(`${dependency.version} in ${text}, not ${version}`);
    }
  }
  // A string dependency is also a prose coordinate, so one fault can appear twice.
  return [...new Set(wrong)];
}

/** The command of a JVM artifact beside the core: the core command with its artifact ID changed. */
function jvmModuleCommand(command: string, artifact: string): string {
  const coordinate = command
    .replace(`run.workhorse:${jvmCoreArtifact}:`, `run.workhorse:${artifact}:`)
    .replace(`<artifactId>${jvmCoreArtifact}</artifactId>`, `<artifactId>${artifact}</artifactId>`);
  if (coordinate === command) throw new Error(`no core artifact ID in ${command}`);
  return coordinate;
}

/** The version that `install.gradle` names, which every JVM coordinate on a page must name. */
function jvmVersion(manifest: InstallManifest): string {
  const version = /^implementation\("run\.workhorse:workhorse:([^"]+)"\)$/.exec(
    manifest.install.gradle,
  )?.[1];
  if (version === undefined) throw new Error(`install.gradle has no core coordinate`);
  return version;
}

/** Markdown wraps prose at will, so a sentence rule compares runs of whitespace as one space. */
function collapse(contents: string): string {
  return contents.replace(/\s+/g, " ");
}

/** The package that owns schema installation. Every other package points at it instead. */
const coreLocation = "typescript/core";

/**
 * An add-on runs against a schema it does not own. Naming core, with a link, is what stops a reader
 * from hunting for a schema step in a package that has none.
 */
const schemaOwnerSentence =
  "[Workhorse core](https://workhorse.run/docs/installation) owns schema installation and changes.";

/** Published packages whose README states no runtime install command, and why. */
const exemptPackageReadmes = new Map([
  [
    "typescript/dashboard-contract/README.md",
    "type-only package installed as a development dependency, never alongside the runtime",
  ],
]);

/**
 * An accepted record states what was decided on its date. ADR 0046 quotes a pinned command that
 * this policy supersedes, and rewriting it would make the record lie about the decision.
 */
const exemptDirectory = "docs/decisions/";

/**
 * Agent-evaluation transcripts are recorded evidence, not reader-facing install instructions, so
 * the command policy deliberately excludes them.
 */
const recordedEvidenceDirectory = "scripts/agent-eval/sessions/";

/** Every shape a Workhorse install command uses to name a version. */
const versionPatterns: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "npm version", pattern: /@stablemates\/[\w-]+@\S+/ },
  { label: "Python version", pattern: /stablemates-workhorse\S*(?:[=<>~!]=|@)\S+/ },
  { label: "Go version", pattern: /stablemates\/workhorse\/go@\S+/ },
  { label: "Rust version", pattern: /cargo add workhorse@\S+/ },
  { label: "Ruby version", pattern: /bundle add stablemates-workhorse\b.*--version\b/ },
  { label: "Gemfile version", pattern: /gem "stablemates-workhorse", ["'~<>=\d]/ },
  { label: "NuGet version", pattern: /dotnet add package Workhorse\b.*(?:--version|-v)\b/ },
];

/** Install commands, extracted so a version is reported against the command that carries it. */
const installCommandPattern =
  /(?:npm (?:install|i)|pnpm add|yarn add|bun add|pip install|pipx install|uv add|go get|cargo add|bundle add|gem "stablemates-workhorse"|npx --package|dotnet add package)[^\n`]*/g;

/**
 * The schema tool, which is the one command that must name a version.
 *
 * It runs from a deployment pipeline rather than from a reader's terminal, and it has to match the
 * SDK the application depends on, so the no-version rule below skips it and a dedicated rule pins
 * it instead.
 */
const schemaCommandPattern = /workhorse schema\b/;

/** `npx` resolves this to an unrelated package outside a project that already depends on ours. */
const bareBinaryPattern = /npx workhorse\b/;

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function readInstallManifest(): Promise<InstallManifest> {
  return JSON.parse(await read("support.json")) as InstallManifest;
}

/** Every tracked Markdown and MDX file the policy governs, with its contents. */
async function documentedSurfaces(): Promise<readonly (readonly [string, string])[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "-z", "*.md", "*.mdx"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const files = stdout
    .split("\0")
    .filter(Boolean)
    .filter(
      (file) => !file.startsWith(exemptDirectory) && !file.startsWith(recordedEvidenceDirectory),
    );
  return Promise.all(files.map(async (file) => [file, await read(file)] as const));
}

describe("install commands", () => {
  it("states the same command on every surface that introduces the product", async () => {
    const manifest = await readInstallManifest();
    const missing: string[] = [];

    for (const surface of governedSurfaces) {
      const contents = await read(surface.file);
      for (const command of surface.commands) {
        if (!contents.includes(manifest.install[command])) {
          missing.push(`${surface.file}: ${manifest.install[command]}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("names no version in any documented install command", async () => {
    const manifest = await readInstallManifest();
    const pinned: string[] = [];

    for (const [file, contents] of await documentedSurfaces()) {
      for (const [command] of contents.matchAll(installCommandPattern)) {
        if (schemaCommandPattern.test(command)) continue;
        for (const { label, pattern } of versionPatterns) {
          if (pattern.test(command)) pinned.push(`${file}: ${label} in ${command.trim()}`);
        }
      }
    }
    for (const [name, command] of Object.entries(manifest.install)) {
      if (schemaCommandPattern.test(command)) continue;
      for (const { label, pattern } of versionPatterns) {
        if (pattern.test(command)) pinned.push(`support.json: ${label} in ${name}`);
      }
    }

    expect(pinned).toEqual([]);
  });

  // The carve-out above removes the sweep from the one command that most needs a rule. These two
  // are what replaces it: the pinned form names the version this repository publishes, and nothing
  // else does.
  it("pins the schema command a project without node_modules runs to the published version", async () => {
    const manifest = await readInstallManifest();
    const core = JSON.parse(await read("typescript/core/package.json")) as { version: string };

    expect(manifest.install.schemaPinned).toContain(`@stablemates/workhorse@${core.version}`);
  });

  // A reader with no Node.js toolchain cannot run the schema tool at all, so the only artifact they
  // can apply is the one the release attaches. That makes the download URL a second pinned literal
  // with the same failure mode: a URL naming a version this repository does not release sends them
  // to a release page that does not exist, and the release workflow is the only thing that puts the
  // file there. These two rules keep the URL, the release step, and the published version equal.
  it("pins the schema download to the release this repository publishes", async () => {
    const manifest = await readInstallManifest();
    const core = JSON.parse(await read("typescript/core/package.json")) as { version: string };

    expect(manifest.install.schemaDownload).toContain(
      `https://github.com/stablemates/workhorse/releases/download/v${core.version}/`,
    );
    expect(await read("site/content/docs/installation.mdx")).toContain(
      `https://github.com/stablemates/workhorse/releases/tag/v${core.version}`,
    );
  });

  it("names an asset the release workflow actually attaches", async () => {
    const manifest = await readInstallManifest();
    const asset = manifest.install.schemaDownload.split("/").at(-1);
    const workflow = await read(".github/workflows/release.yml");

    expect(asset).toBe("schema.sql");
    expect(workflow).toContain(`gh release create "$tag" sql/${asset}`);
    expect(workflow).toContain(`gh release upload "$tag" sql/${asset} --clobber`);
  });

  it("pins the Gradle and Maven coordinates to the JVM train version", async () => {
    const manifest = await readInstallManifest();
    const properties = await read("jvm/gradle.properties");
    const version = /^version=(\S+)$/m.exec(properties)?.[1];

    expect(version).toBeDefined();
    expect(manifest.install.gradle).toBe(`implementation("run.workhorse:workhorse:${version}")`);
    expect(manifest.install.maven).toBe(
      `<dependency><groupId>run.workhorse</groupId><artifactId>workhorse</artifactId><version>${version}</version></dependency>`,
    );
  });

  // `install.dotnet` names only the core. The other three packages of ADR 0107 are optional, so
  // support.json does not state them, but the two pages that list all four must give each command.
  it("gives the command of each optional .NET package on the pages that list all four", async () => {
    const missing: string[] = [];

    for (const file of dotnetPackagePages) {
      const contents = await read(file);
      for (const id of optionalDotnetPackages) {
        if (!contents.includes(`dotnet add package ${id}\n`)) missing.push(`${file}: ${id}`);
      }
    }

    expect(missing).toEqual([]);
  });

  // `install.gradle` and `install.maven` name only the core. The Kotlin module and the starter
  // share its group and version, so their commands change only the artifact ID.
  it("gives the commands of the Kotlin module and the starter on the pages that name them", async () => {
    const manifest = await readInstallManifest();
    const missing: string[] = [];

    for (const { artifact, files } of jvmModulePages) {
      for (const file of files) {
        const contents = await read(file);
        for (const key of ["gradle", "maven"] as const) {
          const command = jvmModuleCommand(manifest.install[key], artifact);
          if (!contents.includes(command)) missing.push(`${file}: ${command}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  // A JVM coordinate cannot drop its version, so the no-version sweep does not apply to it. This
  // sweep replaces it: each Gradle coordinate and each Maven dependency on a page names the group
  // `run.workhorse`, a published artifact, and the version of `install.gradle`, which a rule above
  // holds to the train. A prose name such as `run.workhorse:workhorse` names no version and stays
  // allowed; a dependency in a build line or a Maven block must name one. The sweep guards honest
  // edits in the string, map, and Maven block forms only: it does not parse every build file form.
  it("names the support.json group and version in every JVM dependency on a page", async () => {
    const manifest = await readInstallManifest();
    const version = jvmVersion(manifest);
    const wrong: string[] = [];

    expect(manifest.install.maven).toContain(`<version>${version}</version>`);
    for (const [file, contents] of await documentedSurfaces()) {
      wrong.push(...jvmDependencyErrors(contents, version).map((error) => `${file}: ${error}`));
    }

    expect(wrong).toEqual([]);
  });

  // The core publishes PgJDBC in its runtime variant only, so code that names a PgJDBC class does not
  // compile from the SDK command alone. Each page that shows a Java or Kotlin command says so, with
  // the PgJDBC floor of support.json.
  it("names the PgJDBC floor on the pages that give the JVM commands", async () => {
    const support = JSON.parse(await read("support.json")) as {
      readonly support: { readonly pgjdbc: { readonly minimum: string } };
    };
    const floor = support.support.pgjdbc.minimum;
    const wrong: string[] = [];

    for (const [file, tabs] of pgjdbcPages) {
      const named = [...collapse(await read(file)).matchAll(pgjdbcSentencePattern)].map(
        (match) => match[1],
      );
      if (named.length !== tabs)
        wrong.push(`${file}: ${named.length} PgJDBC sentences, not ${tabs}`);
      for (const version of named) {
        if (version !== floor) wrong.push(`${file}: PgJDBC ${version}, not ${floor}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  // The pages hold only the forms that they use today, so these fixtures keep each form that the
  // sweep reads, and each edge case that review found, under a test.
  it.each([
    ["a string dependency", 'implementation("run.workhorse:workhorse:0.12.0")', []],
    ["a prose name without a version", "Use `run.workhorse:workhorse`.", []],
    ["a full stop after a prose coordinate", "Use run.workhorse:workhorse:0.12.0.", []],
    ["another dependency", 'implementation("org.postgresql:postgresql:42.7.12")', []],
    [
      "a Groovy map",
      'implementation group: "run.workhorse", name: "workhorse-kotlin", version: "0.12.0"',
      [],
    ],
    [
      "a Kotlin map over several lines",
      'implementation(\n  name = "workhorse",\n  group = "run.workhorse",\n  version = "0.12.0"\n)',
      [],
    ],
    [
      "a Maven block with spaced tags",
      "<dependency >\n  <artifactId>workhorse</artifactId>\n  <groupId >run.workhorse</groupId>\n  <version>0.12.0</version>\n</dependency >",
      [],
    ],
    [
      "another group",
      'implementation("com.example:workhorse:0.12.0")',
      ["group com.example in com.example:workhorse:0.12.0"],
    ],
    [
      "an unknown artifact",
      "run.workhorse:workhorse.core:0.12.0",
      ["unknown artifact in run.workhorse:workhorse.core:0.12.0"],
    ],
    [
      "a string dependency without a version",
      'implementation("run.workhorse:workhorse")',
      ["no version in run.workhorse:workhorse"],
    ],
    [
      "an old version in prose",
      "Use run.workhorse:workhorse:0.11.0.",
      ["0.11.0 in run.workhorse:workhorse:0.11.0, not 0.12.0"],
    ],
    [
      "a Kotlin map over several lines with an old version",
      'implementation(\n  group = "run.workhorse",\n  name = "workhorse",\n  version = "0.11.0"\n)',
      [
        '0.11.0 in group = "run.workhorse",\n  name = "workhorse",\n  version = "0.11.0", not 0.12.0',
      ],
    ],
    [
      "a map in another group",
      'implementation name: "workhorse", group: "com.example", version: "0.12.0"',
      ['group com.example in name: "workhorse", group: "com.example", version: "0.12.0"'],
    ],
    [
      "a Maven block without a version",
      "<dependency>\n  <groupId>run.workhorse</groupId>\n  <artifactId>workhorse</artifactId>\n</dependency>",
      [
        "no version in <dependency> <groupId>run.workhorse</groupId> <artifactId>workhorse</artifactId> </dependency>",
      ],
    ],
    [
      "a Maven block with spaced tags and an old version",
      "<dependency >\n<groupId>run.workhorse</groupId><artifactId>workhorse</artifactId><version>0.11.0</version></dependency>",
      [
        "0.11.0 in <dependency > <groupId>run.workhorse</groupId><artifactId>workhorse</artifactId><version>0.11.0</version></dependency>, not 0.12.0",
      ],
    ],
  ] as const)("reads %s", (_name, contents, errors) => {
    expect(jvmDependencyErrors(contents, "0.12.0")).toEqual(errors);
  });

  it("leaves the schema command a TypeScript project runs unpinned and local", async () => {
    const manifest = await readInstallManifest();

    // A version here would be a second source of truth for what the application already declares.
    for (const { pattern } of versionPatterns) {
      expect(manifest.install.schema).not.toMatch(pattern);
    }
    // `--no` is what makes the command resolve the project's own dependency or fail, rather than
    // fetching a stranger's package named `workhorse`.
    expect(manifest.install.schema).toContain("npm exec --no --");
  });

  it("never tells a reader to run the bare `npx workhorse` form", async () => {
    const bare = (await documentedSurfaces())
      .filter(([, contents]) => bareBinaryPattern.test(contents))
      .map(([file]) => file);

    expect(bare).toEqual([]);
  });

  it("points every add-on README at core for schema installation", async () => {
    const manifest = await readInstallManifest();
    const wrong: string[] = [];

    for (const { location } of await publishedPackages()) {
      if (location === coreLocation) continue;
      const file = `${location}/README.md`;
      if (exemptPackageReadmes.has(file)) continue;
      const contents = await read(file);
      // Compared with runs of whitespace collapsed, so rewrapping a paragraph cannot fail the rule.
      if (!collapse(contents).includes(schemaOwnerSentence)) {
        wrong.push(`${file}: does not name core as owner`);
      }
      for (const command of [manifest.install.schema, manifest.install.schemaPinned]) {
        if (contents.includes(command)) wrong.push(`${file}: carries a schema command`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it("governs the README of every published package", async () => {
    const governed = new Set(governedSurfaces.map((surface) => surface.file));
    const ungoverned = (await publishedPackages())
      .map((entry) => `${entry.location}/README.md`)
      .filter((file) => !governed.has(file) && !exemptPackageReadmes.has(file));

    expect(ungoverned).toEqual([]);
  });
});
