import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "./packages.js";

interface SupportManifest {
  readonly support: {
    readonly go: { readonly minimum: string };
    readonly java: { readonly minimum: number };
    readonly node: { readonly tested: readonly number[] };
    readonly postgres: { readonly tested: readonly number[] };
    readonly python: { readonly tested: readonly string[] };
  };
}

/** Minimum language versions a package manifest enforces rather than support.json. */
interface DeclaredMinimums {
  readonly dotnet: string;
  readonly ruby: string;
  readonly rust: string;
}

interface ReadmeContract {
  readonly example: string;
  readonly exampleLanguage: string;
  /**
   * A Java, Kotlin, or C# example sits inside a class or a function body, so its README excerpt drops
   * that indentation. The comparison then ignores the indentation of each line.
   */
  readonly indented?: boolean;
  readonly languageSupport: (
    support: SupportManifest["support"],
    declared: DeclaredMinimums,
  ) => string;
  readonly readme: string;
}

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function prose(contents: string): string {
  return contents.replace(/^>\s?/gm, "").replace(/\s+/g, " ");
}

function naturalList(values: readonly (number | string)[], conjunction = "or"): string {
  const strings = values.map(String);
  if (strings.length === 0) throw new Error("support lists must not be empty");
  if (strings.length === 1) return strings[0]!;
  if (strings.length === 2) return `${strings[0]} ${conjunction} ${strings[1]}`;
  return `${strings.slice(0, -1).join(", ")}, ${conjunction} ${strings.at(-1)}`;
}

function versionRange(values: readonly (number | string)[]): string {
  if (values.length === 0) throw new Error("support lists must not be empty");
  const numeric = values.map((value) => Number(String(value).split(".").at(-1)));
  const consecutive = numeric.every(
    (value, index) => index === 0 || value === numeric[index - 1]! + 1,
  );
  return consecutive && values.length > 2
    ? `${values[0]} through ${values.at(-1)}`
    : naturalList(values);
}

function fencedExamples(contents: string, language: string): string[] {
  return [
    ...contents.matchAll(
      new RegExp(`^\\x60\\x60\\x60${language}\\n([\\s\\S]*?)^\\x60\\x60\\x60$`, "gm"),
    ),
  ].map((match) => match[1]!.trim());
}

const contracts: readonly ReadmeContract[] = [
  {
    readme: "typescript/core/README.md",
    example: "typescript/examples/quickstart.ts",
    exampleLanguage: "ts",
    languageSupport: (support) => `Node.js ${naturalList(support.node.tested)}`,
  },
  {
    readme: "python/README.md",
    example: "python/examples/quickstart.py",
    exampleLanguage: "python",
    languageSupport: (support) => `Python ${versionRange(support.python.tested)}`,
  },
  {
    readme: "go/README.md",
    example: "go/examples/quickstart/main.go",
    exampleLanguage: "go",
    languageSupport: (support) => `Go ${support.go.minimum.replace(/\.0$/, "")} or newer`,
  },
  {
    readme: "rust/README.md",
    example: "rust/examples/quickstart.rs",
    exampleLanguage: "rust",
    languageSupport: (_support, declared) => `Rust ${declared.rust} or newer`,
  },
  {
    readme: "ruby/README.md",
    example: "ruby/examples/quickstart.rb",
    exampleLanguage: "ruby",
    languageSupport: (_support, declared) => `Ruby ${declared.ruby} or newer`,
  },
  // The JVM README quotes the release consumers, which the release check builds and runs.
  {
    readme: "jvm/README.md",
    example: "jvm/release-consumer/java/src/main/java/consumer/Main.java",
    exampleLanguage: "java",
    indented: true,
    languageSupport: (support) => `Java ${support.java.minimum} or newer`,
  },
  {
    readme: "jvm/README.md",
    example: "jvm/release-consumer/kotlin/src/main/kotlin/consumer/Main.kt",
    exampleLanguage: "kotlin",
    indented: true,
    languageSupport: (support) => `Java ${support.java.minimum} or newer`,
  },
  // The .NET README quotes the regions of the README examples, which Workhorse.Examples.Tests runs.
  {
    readme: "dotnet/README.md",
    example: "dotnet/examples/Workhorse.Examples/Readme/ReadmeExamples.cs",
    exampleLanguage: "csharp",
    indented: true,
    languageSupport: (_support, declared) => `.NET ${declared.dotnet} or newer`,
  },
];

function withoutIndentation(contents: string): string {
  return contents.replace(/^[ \t]+/gm, "");
}

/**
 * The one URL every README points an agent at. An agent that lands on a package
 * page has no sidebar and no search, so the README is where it either finds the
 * documentation or gives up and reads the source.
 */
const agentRouter = "https://workhorse.run/llms.txt";

describe("SDK README alignment", () => {
  it("derives every language and PostgreSQL support sentence from support.json", async () => {
    const manifest = JSON.parse(await read("support.json")) as SupportManifest;
    const postgresSupport = `PostgreSQL ${versionRange(manifest.support.postgres.tested)}`;
    // The crate's rust-version, the gem's required_ruby_version, and the target framework of the
    // .NET packages are their minimums, so a README cannot drift from what the build enforces.
    const rust = /^rust-version = "([^"]+)"$/m.exec(await read("rust/Cargo.toml"))?.[1];
    const ruby = /^\s*spec\.required_ruby_version = ">= ([^"]+)"$/m.exec(
      await read("ruby/stablemates-workhorse.gemspec"),
    )?.[1];
    const dotnet = /<TargetFramework>net(\d+)\.0<\/TargetFramework>/.exec(
      await read("dotnet/Directory.Build.props"),
    )?.[1];
    expect(rust).toBeDefined();
    expect(ruby).toBeDefined();
    expect(dotnet).toBeDefined();
    const declared = { dotnet: dotnet!, rust: rust!, ruby: ruby! };

    for (const contract of contracts) {
      const expected = `Requires ${contract.languageSupport(manifest.support, declared)} and ${postgresSupport}.`;
      expect(prose(await read(contract.readme))).toContain(expected);
    }
  });

  it("points every README at the agent documentation router exactly once", async () => {
    const wrongCount: string[] = [];
    // The root README is a product overview with no first task (ADR 0100), so it has no SDK
    // contract, but it still points an agent at the router.
    for (const readme of new Set(["README.md", ...contracts.map((contract) => contract.readme)])) {
      const pointers = (await read(readme)).split(agentRouter).length - 1;
      if (pointers !== 1) wrongCount.push(`${readme}: found ${pointers}, expected 1`);
    }
    expect(wrongCount).toEqual([]);
  });

  it("derives the Go pgx compatibility claim from go/go.mod", async () => {
    const goMod = await read("go/go.mod");
    const pgxVersion = /^require github\.com\/jackc\/pgx\/v5 (v[^\s]+)$/m.exec(goMod)?.[1];
    expect(pgxVersion).toBeDefined();
    expect(prose(await read("go/README.md"))).toContain(
      `pgx ${pgxVersion} is the minimum and the tested version.`,
    );
  });

  it("uses release-tested files for every SDK example block", async () => {
    const missingExamples: string[] = [];
    const staleExamples: string[] = [];
    for (const contract of contracts) {
      const examples = fencedExamples(await read(contract.readme), contract.exampleLanguage);
      const testedExample = await read(contract.example);
      if (examples.length === 0) missingExamples.push(contract.readme);
      for (const example of examples) {
        const found = contract.indented
          ? withoutIndentation(testedExample).includes(withoutIndentation(example))
          : testedExample.includes(example);
        if (!found) {
          staleExamples.push(`${contract.readme}: not an excerpt from ${contract.example}`);
        }
      }
    }
    expect(missingExamples).toEqual([]);
    expect(staleExamples).toEqual([]);
  });
});
