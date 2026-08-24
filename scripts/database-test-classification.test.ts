import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { databaseTestFiles } from "../vitest.config.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const databaseHarnessImport = /from\s+["'][^"']*\/support\/(?:db|integration)\.js["']/;

async function globFiles(patterns: string | string[]): Promise<string[]> {
  const files: string[] = [];
  for await (const file of glob(patterns, { cwd: repositoryRoot })) files.push(file);
  return files;
}

describe("database test classification", () => {
  it("classifies every test that imports a database harness", async () => {
    const [testFiles, classifiedFiles] = await Promise.all([
      globFiles("typescript/*/test/**/*.test.ts"),
      globFiles(databaseTestFiles),
    ]);
    const classified = new Set(classifiedFiles);
    const unclassifiedFiles = (
      await Promise.all(
        testFiles.map(async (testFile) => {
          const source = await readFile(path.join(repositoryRoot, testFile), "utf8");
          return databaseHarnessImport.test(source) && !classified.has(testFile)
            ? testFile
            : undefined;
        }),
      )
    ).filter((testFile) => testFile !== undefined);

    expect(unclassifiedFiles).toEqual([]);
  });
});
