import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PARITY_CLIENT_ROWS,
  PARITY_OPERATOR_ROWS,
  PARITY_WORKER_ROWS,
  type ParityCell,
  type ParityLanguage,
} from "../typescript/core/test/support/parity-capabilities.js";
import { repositoryRoot } from "./packages.js";

const AGENTIC_FLOW_SCENARIO = "agentic-flow";
const coveragePath = path.join(repositoryRoot, "docs/examples-coverage.json");

type FileMapping = { file: string };
type ExclusionMapping = { exclusion: { reason: string; capability?: string } };
type Mapping = FileMapping | ExclusionMapping;

type Coverage = {
  languages: string[];
  scenarios: Record<string, Record<string, Mapping>>;
};

type ParityStatus = "Supported" | "Planned" | "Absent";

function isFileMapping(mapping: Mapping): mapping is FileMapping {
  return "file" in mapping && typeof mapping.file === "string";
}

function cellStatus(cell: ParityCell): ParityStatus {
  if ("absent" in cell) return "Absent";
  if ("planned" in cell) return "Planned";
  return "Supported";
}

const parityRows = [...PARITY_CLIENT_ROWS, ...PARITY_WORKER_ROWS, ...PARITY_OPERATOR_ROWS];

function parityStatus(capability: string, language: string): ParityStatus | undefined {
  const row = parityRows.find((entry) => entry.capability === capability);
  if (row === undefined || !(language in row)) return undefined;
  return cellStatus(row[language as ParityLanguage]);
}

function isExampleFile(language: string, relativePath: string): boolean {
  const name = path.basename(relativePath);
  if (language === "go") return name === "main.go";
  if (language === "python") return name.endsWith(".py") && !name.startsWith("test_");
  if (language === "typescript") {
    return (
      /\.(?:mjs|cjs|js|mts|cts|ts)$/.test(name) &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".spec.ts")
    );
  }
  return false;
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(fullPath)));
    else files.push(fullPath);
  }
  return files;
}

async function discoverLanguages(): Promise<string[]> {
  const entries = await readdir(repositoryRoot, { withFileTypes: true });
  const languages: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const examples = await stat(path.join(repositoryRoot, entry.name, "examples"));
      if (examples.isDirectory()) languages.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return languages.toSorted();
}

function goScenariosFromFiles(files: readonly string[]): string[] {
  return [...new Set(files.map((file) => path.basename(path.dirname(file))))].toSorted();
}

function coverageErrors(input: {
  coverage: Coverage;
  languages: readonly string[];
  exampleFiles: Record<string, readonly string[]>;
  existingFiles: Iterable<string>;
  goScenarios: readonly string[];
  parityStatus: (capability: string, language: string) => ParityStatus | undefined;
}): string[] {
  const errors: string[] = [];
  const existing = new Set(input.existingFiles);
  const languages = [...input.languages].toSorted();
  const declared = [...(input.coverage.languages ?? [])].toSorted();
  if (declared.join("\0") !== languages.join("\0")) {
    errors.push(
      `coverage languages [${declared.join(", ")}] must match example directories [${languages.join(", ")}]`,
    );
  }

  const required = [...new Set([...input.goScenarios, AGENTIC_FLOW_SCENARIO])].toSorted();
  for (const scenario of required) {
    if (!(scenario in (input.coverage.scenarios ?? {}))) {
      errors.push(`untracked scenario ${scenario}`);
    }
  }

  const mappedByLanguage = new Map<string, string[]>(languages.map((language) => [language, []]));

  for (const [scenario, columns] of Object.entries(input.coverage.scenarios ?? {})) {
    const columnLanguages = Object.keys(columns).toSorted();
    if (columnLanguages.join("\0") !== languages.join("\0")) {
      errors.push(
        `scenario ${scenario} columns [${columnLanguages.join(", ")}] must match languages [${languages.join(", ")}]`,
      );
    }
    for (const language of languages) {
      const mapping = columns[language];
      if (mapping === undefined) continue;
      if (isFileMapping(mapping)) {
        if (mapping.file.trim() === "") {
          errors.push(`${scenario}.${language} file is empty`);
          continue;
        }
        if (!existing.has(mapping.file)) {
          errors.push(`${scenario}.${language} maps missing file ${mapping.file}`);
        }
        mappedByLanguage.get(language)?.push(mapping.file);
        continue;
      }
      if ("exclusion" in mapping) {
        if (mapping.exclusion.reason.trim() === "") {
          errors.push(`${scenario}.${language} exclusion has no reason`);
        }
        const capability = mapping.exclusion.capability;
        if (capability !== undefined) {
          const status = input.parityStatus(capability, language);
          if (status === undefined) {
            errors.push(
              `${scenario}.${language} exclusion cites unknown parity capability ${capability}`,
            );
          } else if (status === "Supported") {
            errors.push(
              `${scenario}.${language} exclusion cites ${capability}, which docs/parity.md marks Supported`,
            );
          }
        }
        continue;
      }
      errors.push(`${scenario}.${language} must map a file or a reasoned exclusion`);
    }
  }

  for (const language of languages) {
    const mapped = mappedByLanguage.get(language) ?? [];
    const unique = new Set(mapped);
    if (unique.size !== mapped.length) {
      errors.push(`${language} maps the same example file more than once`);
    }
    const discovered = [...(input.exampleFiles[language] ?? [])].toSorted();
    for (const file of discovered) {
      if (!unique.has(file)) errors.push(`orphan example ${file}`);
    }
    for (const file of unique) {
      if (!discovered.includes(file)) {
        errors.push(`${language} maps ${file}, which is not an example file`);
      }
    }
  }

  return errors;
}

const fixtureCoverage: Coverage = {
  languages: ["typescript", "python", "go"],
  scenarios: {
    quickstart: {
      typescript: { file: "typescript/examples/quickstart.mjs" },
      python: { file: "python/examples/quickstart.py" },
      go: { file: "go/examples/quickstart/main.go" },
    },
    transaction: {
      typescript: { file: "typescript/examples/transaction.mjs" },
      python: { file: "python/examples/async_enqueue.py" },
      go: { file: "go/examples/transaction/main.go" },
    },
    "dedicated-worker": {
      typescript: { file: "typescript/examples/dedicated-worker.mjs" },
      python: { file: "python/examples/dedicated_worker.py" },
      go: { file: "go/examples/dedicated-worker/main.go" },
    },
    orchestration: {
      typescript: { file: "typescript/examples/orchestration.mjs" },
      python: { file: "python/examples/lifecycle.py" },
      go: { file: "go/examples/orchestration/main.go" },
    },
    "demo-worker": {
      typescript: { file: "typescript/examples/demo-worker.mjs" },
      python: { file: "python/examples/demo_worker.py" },
      go: { file: "go/examples/demo-worker/main.go" },
    },
    "agentic-flow": {
      typescript: { file: "typescript/examples/agentic-flow.mjs" },
      python: { exclusion: { reason: "No Python agentic-flow example." } },
      go: { exclusion: { reason: "No Go agentic-flow example." } },
    },
    "async-worker": {
      typescript: { exclusion: { reason: "No TypeScript async-worker example." } },
      python: { file: "python/examples/async_worker.py" },
      go: { exclusion: { reason: "No Go async-worker example." } },
    },
  },
};

const fixtureFiles = {
  typescript: [
    "typescript/examples/agentic-flow.mjs",
    "typescript/examples/dedicated-worker.mjs",
    "typescript/examples/demo-worker.mjs",
    "typescript/examples/orchestration.mjs",
    "typescript/examples/quickstart.mjs",
    "typescript/examples/transaction.mjs",
  ],
  python: [
    "python/examples/async_enqueue.py",
    "python/examples/async_worker.py",
    "python/examples/dedicated_worker.py",
    "python/examples/demo_worker.py",
    "python/examples/lifecycle.py",
    "python/examples/quickstart.py",
  ],
  go: [
    "go/examples/dedicated-worker/main.go",
    "go/examples/demo-worker/main.go",
    "go/examples/orchestration/main.go",
    "go/examples/quickstart/main.go",
    "go/examples/transaction/main.go",
  ],
};

const fixtureInput = {
  coverage: fixtureCoverage,
  languages: ["go", "python", "typescript"],
  exampleFiles: fixtureFiles,
  existingFiles: Object.values(fixtureFiles).flat(),
  goScenarios: ["dedicated-worker", "demo-worker", "orchestration", "quickstart", "transaction"],
  parityStatus,
};

describe("example scenario coverage", () => {
  it("accounts for every SDK example with a file or a reasoned exclusion", async () => {
    const languages = await discoverLanguages();
    const exampleFiles: Record<string, string[]> = {};
    const existingFiles = new Set<string>();
    for (const language of languages) {
      const files = (await listFiles(path.join(repositoryRoot, language, "examples")))
        .map((file) => path.relative(repositoryRoot, file))
        .filter((file) => isExampleFile(language, file))
        .toSorted();
      exampleFiles[language] = files;
      for (const file of files) existingFiles.add(file);
    }
    const coverage = JSON.parse(await readFile(coveragePath, "utf8")) as Coverage;

    expect(
      coverageErrors({
        coverage,
        languages,
        exampleFiles,
        existingFiles,
        goScenarios: goScenariosFromFiles(exampleFiles.go ?? []),
        parityStatus,
      }),
    ).toEqual([]);
  });

  it("fails for an untracked Go scenario or agentic-flow", () => {
    const { transaction: _ignored, ...scenarios } = fixtureCoverage.scenarios;
    expect(
      coverageErrors({
        ...fixtureInput,
        coverage: { ...fixtureCoverage, scenarios },
      }),
    ).toContain("untracked scenario transaction");
  });

  it("fails for an orphan example file", () => {
    expect(
      coverageErrors({
        ...fixtureInput,
        exampleFiles: {
          ...fixtureFiles,
          python: [...fixtureFiles.python, "python/examples/extra.py"],
        },
      }),
    ).toContain("orphan example python/examples/extra.py");
  });

  it("fails when a future SDK is missing a coverage column", () => {
    expect(
      coverageErrors({
        ...fixtureInput,
        languages: ["go", "python", "rust", "typescript"],
        exampleFiles: { ...fixtureFiles, rust: [] },
      }),
    ).toEqual(
      expect.arrayContaining([
        "coverage languages [go, python, typescript] must match example directories [go, python, rust, typescript]",
        "scenario transaction columns [go, python, typescript] must match languages [go, python, rust, typescript]",
      ]),
    );
  });

  it("rejects an exclusion that cites a Supported parity cell", () => {
    expect(
      coverageErrors({
        ...fixtureInput,
        coverage: {
          ...fixtureCoverage,
          scenarios: {
            ...fixtureCoverage.scenarios,
            transaction: {
              ...fixtureCoverage.scenarios.transaction,
              typescript: {
                exclusion: {
                  reason: "Missing because TypeScript cannot enqueue transactionally.",
                  capability: "Transactional enqueue in a caller-owned tx",
                },
              },
            },
          },
        },
      }),
    ).toContain(
      "transaction.typescript exclusion cites Transactional enqueue in a caller-owned tx, which docs/parity.md marks Supported",
    );
  });
});
