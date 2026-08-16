import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requiredTestBuildOutputs } from "./test-build-outputs.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repositoryRoot, "scripts/check-test-build.ts");
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function makeBuiltFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "workhorse-test-build-"));
  fixtureRoots.push(root);
  await Promise.all(
    requiredTestBuildOutputs.map(async (output) => {
      const absolutePath = path.join(root, output);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, "built");
    }),
  );
  return root;
}

async function runCheck(root: string) {
  const child = spawn(process.execPath, [
    "--import",
    path.join(repositoryRoot, "node_modules/tsx/dist/loader.mjs"),
    scriptPath,
    root,
  ]);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { exitCode, stderr };
}

describe("test build prerequisite", () => {
  it("accepts a complete runtime build", async () => {
    const result = await runCheck(await makeBuiltFixture());

    expect(result).toEqual({ exitCode: 0, stderr: "" });
  });

  it("names the build command when an output is missing", async () => {
    const root = await makeBuiltFixture();
    await rm(path.join(root, "typescript/dashboard-server/dist/app/index.html"));

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pnpm build:runtime");
    expect(result.stderr).toContain("typescript/dashboard-server/dist/app/index.html");
  });
});
