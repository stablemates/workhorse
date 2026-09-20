import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executableName,
  gofmtTool,
  readPins,
  satisfiesPin,
  toolsNamedBy,
  verifyTools,
  type VerificationMode,
} from "./verify-toolchain.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const onPosix = process.platform !== "win32";
const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** A directory of fake tools, placed ahead of everything else on the PATH. */
async function toolDirectory(tools: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "workhorse-toolchain-"));
  temporaryDirectories.push(directory);
  await writeTools(directory, tools);
  return directory;
}

async function writeTools(directory: string, tools: Record<string, string>): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, body] of Object.entries(tools)) {
    await writeFile(join(directory, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
}

/** Put a directory ahead of everything already on the PATH, keeping earlier fakes in place. */
function leadPath(directory: string): void {
  process.env.PATH = `${directory}${delimiter}${process.env.PATH ?? ""}`;
}

async function refusals(
  tool: string,
  mode: VerificationMode,
  pins: Iterable<[string, string | undefined]>,
): Promise<string[]> {
  return await verifyTools([{ tool, executable: tool }], {
    mode,
    pins: new Map(pins),
    checkoutRoot: repositoryRoot,
  });
}

describe("mise pin matching", () => {
  it("accepts a version that extends the pin on a dot boundary", () => {
    expect(satisfiesPin("24", "24.21.0")).toBe(true);
    expect(satisfiesPin("3.12", "3.12.14")).toBe(true);
    expect(satisfiesPin("0.8.9", "0.8.9")).toBe(true);
  });

  it("refuses a version that only shares a prefix", () => {
    expect(satisfiesPin("24", "240.1.0")).toBe(false);
    expect(satisfiesPin("0.8.9", "0.8.91")).toBe(false);
    expect(satisfiesPin("0.8.9", "0.9.5")).toBe(false);
  });

  it("reads every pin this repository declares", async () => {
    const pins = await readPins(repositoryRoot);

    expect(pins.get("uv")).toBe("0.8.9");
    expect([...pins.keys()]).toEqual(
      expect.arrayContaining(["go", "lefthook", "node", "pnpm", "python", "uv"]),
    );
  });
});

describe("a substituted tool", () => {
  it.skipIf(!onPosix)("refuses a uv that answers as Python", async () => {
    leadPath(await toolDirectory({ uv: 'echo "Python 3.12.3"' }));

    const [refusal] = await refusals("uv", "identity", [["uv", "0.8.9"]]);

    expect(refusal).toContain("uv did not identify itself");
    expect(refusal).toContain("Python 3.12.3");
    expect(refusal).toContain("mise install uv@0.8.9");
  });

  it.skipIf(!onPosix)("refuses a uv that exits successfully saying nothing", async () => {
    leadPath(await toolDirectory({ uv: "exec cat" }));

    const [refusal] = await refusals("uv", "identity", [["uv", "0.8.9"]]);

    expect(refusal).toContain("printed nothing");
  });

  it.skipIf(!onPosix)("refuses a tool that is not on the PATH at all", async () => {
    leadPath(await toolDirectory({}));
    process.env.PATH = temporaryDirectories.at(-1)!;

    const [refusal] = await refusals("uv", "identity", [["uv", "0.8.9"]]);

    expect(refusal).toContain("uv is not on the PATH");
  });

  it.skipIf(!onPosix)("accepts a uv that answers as the pinned uv does", async () => {
    leadPath(await toolDirectory({ uv: 'echo "uv 0.8.9"' }));

    expect(await refusals("uv", "pinned", [["uv", "0.8.9"]])).toEqual([]);
  });
});

describe("an unpinned version", () => {
  it.skipIf(!onPosix)("names the tool, both versions, and the repair", async () => {
    leadPath(await toolDirectory({ uv: 'echo "uv 0.9.5"' }));

    const [refusal] = await refusals("uv", "pinned", [["uv", "0.8.9"]]);

    expect(refusal).toContain("uv 0.9.5 does not match the mise.toml pin 0.8.9");
    expect(refusal).toContain("mise install uv@0.8.9");
  });

  it.skipIf(!onPosix)("passes the same tool when only identity is asserted", async () => {
    leadPath(await toolDirectory({ uv: 'echo "uv 0.9.5"' }));

    expect(await refusals("uv", "identity", [["uv", "0.8.9"]])).toEqual([]);
  });

  it.skipIf(!onPosix)("reads a version the way each tool reports it", async () => {
    leadPath(
      await toolDirectory({
        go: 'echo "go version go1.25.14 linux/amd64"',
        node: 'echo "v24.21.0"',
        python: 'echo "Python 3.12.14"',
      }),
    );

    expect(await refusals("go", "pinned", [["go", "1.25.14"]])).toEqual([]);
    expect(await refusals("node", "pinned", [["node", "24"]])).toEqual([]);
    expect(await refusals("python", "pinned", [["python", "3.12"]])).toEqual([]);
  });
});

describe("gofmt, which reports no version", () => {
  /**
   * A Go toolchain whose `gofmt` answers a probe with a fixed, recognisable formatting. Built
   * rather than borrowed so the rule is exercised the same way wherever the suite runs.
   */
  async function goToolchain(): Promise<{ goroot: string; formatted: string }> {
    const goroot = await mkdtemp(join(tmpdir(), "workhorse-goroot-"));
    temporaryDirectories.push(goroot);
    await writeTools(join(goroot, "bin"), {
      gofmt: 'printf "package main\\n\\nfunc main() {}\\n"',
    });
    const tools = await toolDirectory({ go: `echo "${goroot}"` });
    leadPath(tools);
    return { goroot, formatted: "package main\n\nfunc main() {}\n" };
  }

  it.skipIf(!onPosix)("accepts a gofmt inside the directory go names", async () => {
    const { goroot } = await goToolchain();
    leadPath(join(goroot, "bin"));

    expect(await refusals(gofmtTool, "identity", [["go", "1.25.14"]])).toEqual([]);
  });

  it.skipIf(!onPosix)("refuses a gofmt outside it that returns its input unchanged", async () => {
    const { goroot } = await goToolchain();
    leadPath(await toolDirectory({ gofmt: "exec cat" }));

    const [refusal] = await refusals(gofmtTool, "identity", [["go", "1.25.14"]]);

    expect(refusal).toContain("does not format as the Go toolchain at");
    expect(refusal).toContain(goroot);
    expect(refusal).toContain("mise install go@1.25.14");
  });

  it.skipIf(!onPosix)("accepts a shim outside it that formats as the toolchain does", async () => {
    const { goroot, formatted } = await goToolchain();
    leadPath(await toolDirectory({ gofmt: `exec ${join(goroot, "bin", "gofmt")}` }));

    expect(await refusals(gofmtTool, "identity", [["go", "1.25.14"]])).toEqual([]);
    expect(formatted).toContain("func main() {}");
  });
});

describe("no environment variable skips the check", () => {
  it.skipIf(!onPosix)("refuses a substituted tool whatever the caller sets", async () => {
    leadPath(await toolDirectory({ uv: "exec cat" }));
    const skipAttempts = {
      CI: "true",
      SKIP_TOOLCHAIN_CHECK: "1",
      WORKHORSE_SKIP_TOOLCHAIN: "1",
      LEFTHOOK: "0",
    };
    const previous = Object.fromEntries(
      Object.keys(skipAttempts).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, skipAttempts);

    try {
      expect(await refusals("uv", "identity", [["uv", "0.8.9"]])).toHaveLength(1);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("reads no variable that could turn the check off", async () => {
    const source = await readFile(join(repositoryRoot, "scripts/verify-toolchain.ts"), "utf8");
    const read = [...source.matchAll(/process\.env(?:\.(\w+)|\[["'](\w+)["']\])/g)].map(
      (match) => match[1] ?? match[2],
    );

    expect(read).toEqual(["PATHEXT", "PATH"]);
  });
});

describe("the tools a repository command starts", () => {
  const checkable = new Set(["go", gofmtTool, "node", "pnpm", "uv"]);

  it("checks the command itself, as written", () => {
    expect(toolsNamedBy("/usr/bin/uv", ["run", "ruff"], checkable)).toEqual([
      { tool: "uv", executable: "/usr/bin/uv" },
    ]);
  });

  it("checks the tools a shell script names, because a pipe hides them", () => {
    expect(toolsNamedBy("sh", ["-c", "gofmt -l go | diff -u /dev/null -"], checkable)).toEqual([
      { tool: gofmtTool, executable: gofmtTool },
      { tool: "go", executable: "go" },
    ]);
  });

  it("checks nothing for a command no pin covers", () => {
    expect(toolsNamedBy("tsx", ["scripts/portless.ts"], checkable)).toEqual([]);
  });

  it("reads an executable name without its directory", () => {
    expect(executableName("/usr/local/share/mise/shims/gofmt")).toBe("gofmt");
  });
});

describe("the CI uv pin", () => {
  it("names the version mise.toml pins", async () => {
    const [pins, workflow] = await Promise.all([
      readPins(repositoryRoot),
      readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
    ]);
    const setups = workflow.match(/astral-sh\/setup-uv@/g) ?? [];
    const pinned = workflow.match(/^ {10}version: (\S+)/gm) ?? [];

    expect(pinned).toHaveLength(setups.length);
    for (const line of pinned) expect(line).toContain(pins.get("uv"));
  });
});
