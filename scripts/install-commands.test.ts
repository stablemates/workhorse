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

const execFileAsync = promisify(execFile);

type InstallCommand = "go" | "node" | "python" | "schema";

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
  { file: "python/README.md", commands: ["python", "schema"] },
  { file: "go/README.md", commands: ["go", "schema"] },
  { file: "go/examples/README.md", commands: ["go"] },
  { file: "site/content/docs/installation.mdx", commands: ["go", "node", "python", "schema"] },
  { file: "site/content/docs/quickstart.mdx", commands: ["go", "node", "python", "schema"] },
  { file: "site/content/docs/for-ai-agents.mdx", commands: ["go", "node", "python", "schema"] },
  { file: "site/content/docs/api.mdx", commands: ["schema"] },
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
        for (const { label, pattern } of versionPatterns) {
          if (pattern.test(command)) pinned.push(`${file}: ${label} in ${command.trim()}`);
        }
      }
    }
    for (const command of Object.values(manifest.install)) {
      for (const { label, pattern } of versionPatterns) {
        if (pattern.test(command)) pinned.push(`support.json: ${label} in ${command}`);
      }
    }

    expect(pinned).toEqual([]);
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
      if (contents.includes(manifest.install.schema))
        wrong.push(`${file}: carries a schema command`);
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
