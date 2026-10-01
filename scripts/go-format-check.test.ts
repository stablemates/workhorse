import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gofmtTool, toolsNamedBy } from "./verify-toolchain.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const onPosix = process.platform !== "win32";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** The `go:fmt:check` command exactly as `package.json` declares it. */
async function declaredCommand(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  return manifest.scripts["go:fmt:check"]!;
}

const wrapperPrefix = "tsx scripts/with-env.ts sh -c '";

/** The shell script the wrapper hands to `sh -c`. */
async function declaredScript(): Promise<string> {
  const command = await declaredCommand();
  expect(command.startsWith(wrapperPrefix) && command.endsWith("'")).toBe(true);
  return command.slice(wrapperPrefix.length, -1);
}

/** Run the declared script with the real gofmt against a `go` directory holding one file. */
async function checkGoSource(source: string): Promise<{ exitCode: number; output: string }> {
  const checkout = await mkdtemp(join(tmpdir(), "workhorse-gofmt-check-"));
  temporaryDirectories.push(checkout);
  await mkdir(join(checkout, "go"));
  await writeFile(join(checkout, "go", "a.go"), source);
  const script = await declaredScript();
  return new Promise((resolvePromise) => {
    execFile("sh", ["-c", script], { cwd: checkout }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : error ? -1 : 0;
      resolvePromise({ exitCode: code, output: `${stdout}${stderr}` });
    });
  });
}

describe("go:fmt:check", () => {
  it("stays behind the environment wrapper, which checks the gofmt it names", async () => {
    const command = await declaredCommand();
    expect(command.startsWith(wrapperPrefix)).toBe(true);
    const tools = toolsNamedBy("sh", ["-c", await declaredScript()], new Set(["go", gofmtTool]));
    expect(tools).toContainEqual({ tool: gofmtTool, executable: gofmtTool });
  });

  it.skipIf(!onPosix)("passes formatted source", async () => {
    expect(await checkGoSource("package ok\n\nfunc main() {}\n")).toEqual({
      exitCode: 0,
      output: "",
    });
  });

  it.skipIf(!onPosix)("fails unformatted source and names the file", async () => {
    const result = await checkGoSource("package ok\nfunc main(){}\n");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("go/a.go");
  });

  it.skipIf(!onPosix)("fails source gofmt cannot parse, which it lists as nothing", async () => {
    const result = await checkGoSource("package broken\nfunc (\n");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("expected ')'");
  });
});
