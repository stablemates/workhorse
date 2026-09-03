import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "./packages.js";

interface SupportManifest {
  readonly support: {
    readonly go: { readonly minimum: string };
    readonly node: { readonly tested: readonly number[] };
    readonly postgres: { readonly tested: readonly number[] };
    readonly python: { readonly tested: readonly string[] };
  };
}

interface ReadmeContract {
  readonly example: string;
  readonly exampleLanguage: string;
  readonly languageSupport: (support: SupportManifest["support"]) => string;
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
    readme: "README.md",
    example: "typescript/examples/quickstart.mjs",
    exampleLanguage: "ts",
    languageSupport: (support) => `Node.js ${naturalList(support.node.tested)}`,
  },
  {
    readme: "typescript/core/README.md",
    example: "typescript/examples/quickstart.mjs",
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
];

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

    for (const contract of contracts) {
      const expected = `Requires ${contract.languageSupport(manifest.support)} and ${postgresSupport}.`;
      expect(prose(await read(contract.readme))).toContain(expected);
    }
  });

  it("points every README at the agent documentation router exactly once", async () => {
    const wrongCount: string[] = [];
    for (const contract of contracts) {
      const pointers = (await read(contract.readme)).split(agentRouter).length - 1;
      if (pointers !== 1) wrongCount.push(`${contract.readme}: found ${pointers}, expected 1`);
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
        if (!testedExample.includes(example)) {
          staleExamples.push(`${contract.readme}: not an excerpt from ${contract.example}`);
        }
      }
    }
    expect(missingExamples).toEqual([]);
    expect(staleExamples).toEqual([]);
  });
});
