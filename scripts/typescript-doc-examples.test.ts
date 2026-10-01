import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "./packages.js";

/**
 * How one documented `ts` fence becomes a compilable module.
 *
 * A fence that reads like a whole file compiles as written. A fence that shows the inside of a
 * handler supplies `wrap`, which places it in a function whose parameters it reads.
 */
interface FenceContract {
  readonly file: string;
  /** One-based position of the fence among the file's `ts` fences. */
  readonly fence: number;
  readonly wrap?: (source: string) => string;
}

/**
 * Application values the examples read but do not define. Only these are ambient: the Workhorse
 * API itself comes from the package, so an untyped payload or parameter still fails.
 */
const applicationHarness = `import type { Queue, Worker } from "@stablemates/workhorse";

declare global {
  const queue: Queue;
  const worker: Worker;
  const orderId: string;
  function chargeCard(orderId: string): Promise<{ chargeId: string }>;
  function printLabel(orderId: string): Promise<{ labelId: string }>;
}
`;

const contracts: readonly FenceContract[] = [
  { file: "README.md", fence: 1 },
  { file: "typescript/core/README.md", fence: 1 },
  { file: "site/content/docs/index.mdx", fence: 1 },
  { file: "site/content/docs/index.mdx", fence: 2 },
  { file: "docs/guides/170-child-tasks.md", fence: 1 },
  {
    file: "docs/guides/170-child-tasks.md",
    fence: 2,
    wrap: (source) =>
      `import type { HandlerContext } from "@stablemates/workhorse";\n\n` +
      `export async function handler(ctx: HandlerContext) {\n${source}\n  return { accepted: true };\n}\n`,
  },
];

function typescriptFences(contents: string): string[] {
  return [...contents.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((match) => match[1]!);
}

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ["lib.es2023.d.ts"],
  types: ["node"],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  // The public entry point, read from source so the check needs no build.
  paths: {
    "@stablemates/workhorse": [path.join(repositoryRoot, "typescript/core/src/index.ts")],
  },
};

/** Compiles each fence as its own module and returns every diagnostic the fences produce. */
async function fenceDiagnostics(): Promise<string[]> {
  const sandbox = path.join(repositoryRoot, ".build", "doc-examples");
  const virtualFiles = new Map<string, string>([
    [path.join(sandbox, "application-harness.d.mts"), applicationHarness],
  ]);
  const errors: string[] = [];
  const labels = new Map<string, string>();
  const fencesByFile = new Map<string, string[]>();

  for (const contract of contracts) {
    let fences = fencesByFile.get(contract.file);
    if (!fences) {
      fences = typescriptFences(await readFile(path.join(repositoryRoot, contract.file), "utf8"));
      fencesByFile.set(contract.file, fences);
    }
    const label = `${contract.file} ts fence ${contract.fence}`;
    const source = fences[contract.fence - 1];
    if (source === undefined) {
      errors.push(`${label}: missing`);
      continue;
    }
    const fileName = path.join(
      sandbox,
      `${contract.file.replaceAll("/", "__")}.${contract.fence}.mts`,
    );
    // `export {}` makes a fence without imports a module, so its names stay its own.
    virtualFiles.set(fileName, `${contract.wrap ? contract.wrap(source) : source}\nexport {};\n`);
    labels.set(fileName, label);
  }

  const host = ts.createCompilerHost(compilerOptions);
  const readHostFile = host.readFile.bind(host);
  const hostFileExists = host.fileExists.bind(host);
  host.readFile = (fileName) => virtualFiles.get(fileName) ?? readHostFile(fileName);
  host.fileExists = (fileName) => virtualFiles.has(fileName) || hostFileExists(fileName);
  const getHostSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const contents = virtualFiles.get(fileName);
    return contents === undefined
      ? getHostSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, contents, languageVersion, true);
  };

  const program = ts.createProgram([...virtualFiles.keys()], compilerOptions, host);
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    const fileName = diagnostic.file?.fileName;
    const label = fileName ? (labels.get(fileName) ?? path.relative(repositoryRoot, fileName)) : "";
    const position =
      diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : undefined;
    const location = position ? `:${position.line + 1}` : "";
    errors.push(`${label}${location}: TS${diagnostic.code} ${message}`);
  }
  return errors;
}

describe("TypeScript documentation examples", () => {
  it("compile under strict TypeScript against the public entry point", async () => {
    expect(await fenceDiagnostics()).toEqual([]);
  }, 60_000);
});
