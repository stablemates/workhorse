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
// fetch anything when it is absent. A Python or Go project has no `node_modules` to resolve from,
// so its command names the version explicitly, and the rule below is what keeps that literal equal
// to the version this repository publishes.

const execFileAsync = promisify(execFile);

type InstallCommand = "go" | "node" | "python" | "schema" | "schemaDownload" | "schemaPinned";

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
  { file: "README.md", commands: ["node", "schema"] },
  { file: "typescript/core/README.md", commands: ["node", "schema"] },
  { file: "typescript/dashboard/README.md", commands: ["node"] },
  { file: "typescript/dashboard-server/README.md", commands: ["node"] },
  { file: "typescript/drizzle/README.md", commands: ["node"] },
  { file: "typescript/kysely/README.md", commands: ["node"] },
  { file: "typescript/otel/README.md", commands: ["node"] },
  { file: "typescript/prisma/README.md", commands: ["node"] },
  { file: "typescript/typeorm/README.md", commands: ["node"] },
  { file: "python/README.md", commands: ["python", "schemaPinned"] },
  { file: "go/README.md", commands: ["go", "schemaPinned"] },
  { file: "go/examples/README.md", commands: ["go"] },
  {
    file: "site/content/docs/installation.mdx",
    commands: ["go", "node", "python", "schema", "schemaDownload", "schemaPinned"],
  },
  {
    file: "site/content/docs/quickstart.mdx",
    commands: ["go", "node", "python", "schema", "schemaPinned"],
  },
  {
    file: "site/content/docs/for-ai-agents.mdx",
    commands: ["go", "node", "python", "schema", "schemaPinned"],
  },
  { file: "site/content/docs/api.mdx", commands: ["schema", "schemaPinned"] },
];

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

/** Every shape a Workhorse install command uses to name a version. */
const versionPatterns: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "npm version", pattern: /@stablemates\/[\w-]+@\S+/ },
  { label: "Python version", pattern: /stablemates-workhorse\S*(?:[=<>~!]=|@)\S+/ },
  { label: "Go version", pattern: /stablemates\/workhorse\/go@\S+/ },
];

/** Install commands, extracted so a version is reported against the command that carries it. */
const installCommandPattern =
  /(?:npm (?:install|i)|pnpm add|yarn add|bun add|pip install|pipx install|uv add|go get|npx --package)[^\n`]*/g;

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
    .filter((file) => !file.startsWith(exemptDirectory));
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
