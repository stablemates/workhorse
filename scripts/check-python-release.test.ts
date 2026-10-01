import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { typecheckConfigProblem } from "./check-python-release.js";

const manifestPath = path.resolve(import.meta.dirname, "..", "package.json");

describe("the Python typecheck", () => {
  it("loads the package's strict mypy configuration", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(typecheckConfigProblem(manifest.scripts["python:typecheck"])).toBeUndefined();
  });

  it("names a typecheck that runs mypy without the package configuration", () => {
    expect(typecheckConfigProblem("uv run --project python mypy python/src/workhorse")).toBe(
      "python:typecheck does not pass --config-file=python/pyproject.toml, so mypy skips strict mode",
    );
  });

  it("names a missing or mypy-free typecheck", () => {
    expect(typecheckConfigProblem(undefined)).toBe(
      "package.json defines no python:typecheck script",
    );
    expect(typecheckConfigProblem("uv run --project python pyright")).toBe(
      "python:typecheck does not run mypy",
    );
  });
});
