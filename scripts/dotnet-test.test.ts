import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { DOTNET_TEST_PROJECTS, dotnetRunArguments } from "./dotnet-test.js";

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

it("gives each project the same extra arguments", () => {
  expect(dotnetRunArguments("dotnet/tests/A", ["--property:RollForward=LatestMajor"])).toEqual([
    "run",
    "--project",
    "dotnet/tests/A",
    "--property:RollForward=LatestMajor",
  ]);
});
