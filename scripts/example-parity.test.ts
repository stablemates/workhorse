import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PARITY_CLIENT_ROWS,
  PARITY_OPERATOR_ROWS,
  PARITY_WORKER_ROWS,
  type ParityCell,
} from "../typescript/core/test/support/parity-capabilities.js";
import { repositoryRoot } from "./packages.js";

const AGENTIC_FLOW_SCENARIO = "agentic-flow";
const coveragePath = path.join(repositoryRoot, "docs/examples-coverage.json");

type FileMapping = { file: string };
// A scenario whose JVM program has a Java and a Kotlin form maps both files.
type FilesMapping = { files: string[] };
type ExclusionMapping = { exclusion: { reason: string; capability?: string } };
type Mapping = FileMapping | FilesMapping | ExclusionMapping;

type Coverage = {
  languages: string[];
  scenarios: Record<string, Record<string, Mapping>>;
};

type ParityStatus = "Supported" | "Planned" | "Absent";

function isFileMapping(mapping: Mapping): mapping is FileMapping {
  return "file" in mapping && typeof mapping.file === "string";
}

function isFilesMapping(mapping: Mapping): mapping is FilesMapping {
  return (
    "files" in mapping &&
    Array.isArray(mapping.files) &&
    mapping.files.every((file) => typeof file === "string")
  );
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
  const cell = (row as unknown as Record<string, ParityCell | undefined>)[language];
  return cell === undefined ? undefined : cellStatus(cell);
}

function isExampleFile(language: string, relativePath: string): boolean {
  const name = path.basename(relativePath);
  if (language === "go") return name === "main.go";
  if (language === "python") return name.endsWith(".py") && !name.startsWith("test_");
  // docs.rs and landing.rs hold the regions the documentation site and its landing page embed,
  // and agent_playbook.rs is the program the agent playbook page embeds whole. None is a scenario
  // the other languages mirror.
  if (language === "rust") {
    return name.endsWith(".rs") && !["docs.rs", "landing.rs", "agent_playbook.rs"].includes(name);
  }
  // The Ruby files follow the same split. active_job.rb holds the Active Job page's regions, and
  // no other language has an Active Job adapter to mirror it.
  if (language === "ruby") {
    return (
      name.endsWith(".rb") &&
      !["docs.rb", "landing.rb", "agent_playbook.rb", "active_job.rb"].includes(name)
    );
  }
  // The scenario programs are the Java and Kotlin sources of the jvm/examples/programs project,
  // apart from its package-info.java and the Programs.java helper that every program shares. The
  // other files in jvm/examples hold the regions that the documentation embeds, as docs.rs and
  // docs.rb do, or the tests that run them. None of those is a scenario the other languages mirror.
  if (language === "jvm") {
    return (
      relativePath.startsWith("jvm/examples/programs/src/main/") &&
      (name.endsWith(".java") || name.endsWith(".kt")) &&
      name !== "package-info.java" &&
      name !== "Programs.java"
    );
  }
  // The C# scenario programs are the files in Scenarios/ of the Workhorse.Examples.Programs
  // project. Its Program.cs only starts the scenario that its first argument names. The other
  // projects in dotnet/examples hold the regions that the documentation embeds, or the tests.
  if (language === "dotnet") {
    return (
      relativePath.startsWith("dotnet/examples/Workhorse.Examples.Programs/Scenarios/") &&
      name.endsWith(".cs")
    );
  }
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
      if (isFileMapping(mapping) || isFilesMapping(mapping)) {
        const files = isFileMapping(mapping) ? [mapping.file] : mapping.files;
        if (files.length === 0) errors.push(`${scenario}.${language} files is empty`);
        for (const file of files) {
          if (file.trim() === "") {
            errors.push(`${scenario}.${language} file is empty`);
            continue;
          }
          if (!existing.has(file)) {
            errors.push(`${scenario}.${language} maps missing file ${file}`);
          }
          mappedByLanguage.get(language)?.push(file);
        }
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

  it("accepts a cell that maps several files, and holds each file to the same checks", () => {
    const orchestration = {
      ...fixtureCoverage.scenarios.orchestration,
      go: { files: ["go/examples/orchestration/main.go", "go/examples/orchestration/extra.go"] },
    };
    const input = {
      ...fixtureInput,
      coverage: {
        ...fixtureCoverage,
        scenarios: { ...fixtureCoverage.scenarios, orchestration },
      },
    };
    const extraFiles = {
      ...fixtureFiles,
      go: [...fixtureFiles.go, "go/examples/orchestration/extra.go"],
    };
    expect(
      coverageErrors({
        ...input,
        exampleFiles: extraFiles,
        existingFiles: Object.values(extraFiles).flat(),
      }),
    ).toEqual([]);
    expect(coverageErrors(input)).toEqual(
      expect.arrayContaining([
        "orchestration.go maps missing file go/examples/orchestration/extra.go",
        "go maps go/examples/orchestration/extra.go, which is not an example file",
      ]),
    );
    expect(
      coverageErrors({
        ...fixtureInput,
        coverage: {
          ...fixtureCoverage,
          scenarios: {
            ...fixtureCoverage.scenarios,
            orchestration: { ...fixtureCoverage.scenarios.orchestration, go: { files: [] } },
          },
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        "orchestration.go files is empty",
        "orphan example go/examples/orchestration/main.go",
      ]),
    );
    expect(
      coverageErrors({
        ...fixtureInput,
        coverage: {
          ...fixtureCoverage,
          scenarios: {
            ...fixtureCoverage.scenarios,
            orchestration: {
              ...fixtureCoverage.scenarios.orchestration,
              go: {
                files: ["go/examples/orchestration/main.go", "go/examples/orchestration/main.go"],
              },
            },
          },
        },
      }),
    ).toContain("go maps the same example file more than once");
  });

  it("counts the JVM scenario programs as examples, and not the documentation regions", () => {
    const programs = "jvm/examples/programs/src/main";
    expect(
      [
        `${programs}/java/run/workhorse/examples/programs/QuickstartProgram.java`,
        `${programs}/kotlin/run/workhorse/examples/programs/OrchestrationProgram.kt`,
        `${programs}/java/run/workhorse/examples/programs/package-info.java`,
        `${programs}/java/run/workhorse/examples/programs/Programs.java`,
        "jvm/examples/programs/src/test/java/run/workhorse/examples/programs/ScenarioProgramsTest.java",
        "jvm/examples/programs/build.gradle.kts",
        "jvm/examples/src/main/java/run/workhorse/examples/QuickstartExamples.java",
        "jvm/examples/src/main/kotlin/run/workhorse/examples/QuickstartExamples.kt",
      ].map((file) => isExampleFile("jvm", file)),
    ).toEqual([true, true, false, false, false, false, false, false]);
  });

  it("counts the C# scenario programs as examples, and not the documentation regions", () => {
    const programs = "dotnet/examples/Workhorse.Examples.Programs";
    expect(
      [
        `${programs}/Scenarios/QuickstartProgram.cs`,
        `${programs}/Scenarios/AgenticFlowProgram.cs`,
        `${programs}/Program.cs`,
        `${programs}/ProgramDatabase.cs`,
        `${programs}/Workhorse.Examples.Programs.csproj`,
        `${programs}/obj/Debug/net10.0/Workhorse.Examples.Programs.AssemblyInfo.cs`,
        "dotnet/examples/Workhorse.Examples.Programs.Tests/ScenarioProgramsTests.cs",
        "dotnet/examples/Workhorse.Examples/Pages/RetriesExamples.cs",
      ].map((file) => isExampleFile("dotnet", file)),
    ).toEqual([true, true, false, false, false, false, false, false]);
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
