import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { DOTNET_TEST_PROJECTS, dotnetRunArguments, testThreads } from "./dotnet-test.js";

const repository = path.resolve(import.meta.dirname, "..");

it("runs every .NET test project of the solution", async () => {
  const projects: string[] = [];
  // The package tests live in dotnet/tests. The tests of the documentation snippets and the
  // scenario programs live beside them in dotnet/examples.
  for (const parent of ["dotnet/tests", "dotnet/examples"]) {
    const directory = path.join(repository, parent);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const file of await readdir(path.join(directory, entry.name))) {
        if (!file.endsWith(".csproj")) continue;
        const project = await readFile(path.join(directory, entry.name, file), "utf8");
        if (project.includes("<IsTestProject>true</IsTestProject>")) {
          projects.push(`${parent}/${entry.name}`);
        }
      }
    }
  }
  expect([...DOTNET_TEST_PROJECTS].toSorted()).toEqual(projects.toSorted());
});

it("gives each project the same extra arguments and the thread limit", () => {
  expect(dotnetRunArguments("dotnet/tests/A", ["--property:RollForward=LatestMajor"], 2)).toEqual([
    "run",
    "--project",
    "dotnet/tests/A",
    "--property:RollForward=LatestMajor",
    "--",
    "-maxThreads",
    "2",
  ]);
});

it("keeps the arguments of the test program after the thread limit", () => {
  expect(
    dotnetRunArguments("dotnet/tests/A", ["-c", "Release", "--", "-method", "*Name*"], 8),
  ).toEqual([
    "run",
    "--project",
    "dotnet/tests/A",
    "-c",
    "Release",
    "--",
    "-maxThreads",
    "8",
    "-method",
    "*Name*",
  ]);
});

it("keeps a thread limit that the caller gives", () => {
  expect(dotnetRunArguments("dotnet/tests/A", ["--", "-maxThreads", "1"], 8)).toEqual([
    "run",
    "--project",
    "dotnet/tests/A",
    "--",
    "-maxThreads",
    "1",
  ]);
});

// xUnit runs one test class for each processor. The limit must not raise that number, because a
// CI runner has 2 processors, and more classes at the same time make the timing tests fail.
it("runs at most 8 test classes and never more than the processors", () => {
  expect(testThreads(2)).toBe(2);
  expect(testThreads(8)).toBe(8);
  expect(testThreads(32)).toBe(8);
});
