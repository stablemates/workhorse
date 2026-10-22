import { readdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { DOTNET_TEST_PROJECTS, dotnetRunArguments } from "./dotnet-test.js";

const repository = path.resolve(import.meta.dirname, "..");

it("runs every .NET test project of the solution", async () => {
  const directory = path.join(repository, "dotnet/tests");
  const projects: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = await readdir(path.join(directory, entry.name));
    if (files.some((file) => file.endsWith(".csproj"))) projects.push(`dotnet/tests/${entry.name}`);
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
