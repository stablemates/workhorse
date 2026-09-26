import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishedPackages, repositoryRoot } from "./packages.js";

/**
 * Post-publish version checks for each registry on the release train.
 *
 * Every step is an exact command and the output it must print. The release handoff names
 * `pnpm release:verify <target> <version>` instead of restating commands, and the Python
 * rehearsal runs the same steps against the dry-run wheel, so a check the package cannot satisfy
 * fails before `python/v*` is tagged. Provenance review and the enqueue-and-worker smoke stay with
 * the maintainer; `docs/compatibility.md` → Release train lists them.
 */

type VerifyTarget = "crate" | "go" | "npm" | "python";

export interface VerificationStep {
  /** Program, resolved from PATH unless it names a path inside the scratch directory. */
  readonly command: string;
  readonly args: readonly string[];
  /** Extra environment for this step only. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Trimmed stdout the step must print. Absent means only the exit status counts. */
  readonly expect?: string;
}

export interface VerificationOptions {
  /** A local wheel to install instead of the PyPI release. The rehearsal passes the dry-run wheel. */
  readonly wheel?: string;
}

const pythonDistribution = "stablemates-workhorse";
const goModule = "github.com/stablemates/workhorse/go";
// The public proxy only, with no `direct` fallback, so a version the proxy cannot serve fails.
const goEnvironment = { GOFLAGS: "-mod=mod", GOPROXY: "https://proxy.golang.org", GOWORK: "off" };

// The oldest supported Python, so the check also proves the floor `requires-python` declares.
async function pythonFloor(): Promise<string> {
  const support = JSON.parse(await readFile(path.join(repositoryRoot, "support.json"), "utf8")) as {
    readonly support: { readonly python: { readonly minimum: string } };
  };
  return support.support.python.minimum;
}

async function pythonSteps(
  version: string,
  options: VerificationOptions,
): Promise<VerificationStep[]> {
  const python = "venv/bin/python";
  return [
    { command: "uv", args: ["venv", "--python", await pythonFloor(), "venv"] },
    {
      command: "uv",
      args: [
        "pip",
        "install",
        "--python",
        python,
        "--refresh",
        options.wheel ?? `${pythonDistribution}==${version}`,
      ],
    },
    {
      command: python,
      args: ["-c", "import workhorse; print(workhorse.__version__)"],
      expect: version,
    },
    {
      command: python,
      args: [
        "-c",
        `import importlib.metadata; print(importlib.metadata.version("${pythonDistribution}"))`,
      ],
      expect: version,
    },
  ];
}

async function npmSteps(version: string): Promise<VerificationStep[]> {
  const packages = await publishedPackages();
  return [
    ...packages.map((entry) => ({
      command: "npm",
      args: ["view", `${entry.name}@${version}`, "version"],
      expect: version,
    })),
    { command: "npm", args: ["init", "--yes"] },
    { command: "npm", args: ["install", `${packages[0]!.name}@${version}`] },
    { command: "npm", args: ["audit", "signatures"] },
    { command: "npx", args: ["--no-install", "workhorse", "--version"], expect: version },
  ];
}

function crateSteps(version: string): VerificationStep[] {
  return [
    { command: "cargo", args: ["init", "--name", "release_verify", "--vcs", "none"] },
    { command: "cargo", args: ["add", `workhorse@=${version}`] },
    { command: "cargo", args: ["generate-lockfile"] },
    {
      command: "cargo",
      args: ["pkgid", "workhorse"],
      expect: `registry+https://github.com/rust-lang/crates.io-index#workhorse@${version}`,
    },
  ];
}

function goSteps(version: string): VerificationStep[] {
  const tagged = `${goModule}@v${version}`;
  return [
    {
      command: "go",
      args: ["list", "-m", tagged],
      environment: goEnvironment,
      expect: `${goModule} v${version}`,
    },
    {
      command: "go",
      args: ["mod", "init", "example.com/release-verify"],
      environment: goEnvironment,
    },
    { command: "go", args: ["get", tagged], environment: goEnvironment },
    {
      command: "go",
      args: ["mod", "verify"],
      environment: goEnvironment,
      expect: "all modules verified",
    },
    {
      command: "go",
      args: ["list", "-m", goModule],
      environment: goEnvironment,
      expect: `${goModule} v${version}`,
    },
  ];
}

export async function verificationSteps(
  target: VerifyTarget,
  version: string,
  options: VerificationOptions = {},
): Promise<readonly VerificationStep[]> {
  if (options.wheel !== undefined && target !== "python") {
    throw new Error("--wheel applies only to the python target");
  }
  switch (target) {
    case "python":
      return await pythonSteps(version, options);
    case "npm":
      return await npmSteps(version);
    case "crate":
      return crateSteps(version);
    case "go":
      return goSteps(version);
  }
}

function render(step: VerificationStep): string {
  const quoted = [step.command, ...step.args].map((part) =>
    /^[\w@=./:+-]+$/.test(part) ? part : `'${part.replaceAll("'", String.raw`'\''`)}'`,
  );
  const environment = Object.entries(step.environment ?? {}).map(
    ([key, value]) => `${key}=${value}`,
  );
  return [...environment, ...quoted].join(" ");
}

async function runStep(step: VerificationStep, directory: string): Promise<void> {
  process.stdout.write(`$ ${render(step)}\n`);
  const command = step.command.includes("/") ? path.join(directory, step.command) : step.command;
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...step.args], {
      cwd: directory,
      env: { ...process.env, ...step.environment },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${render(step)} exited with ${signal ?? String(code)}`));
    });
  });
  if (step.expect !== undefined && stdout.trim() !== step.expect) {
    throw new Error(
      `${render(step)} printed ${JSON.stringify(stdout.trim())}, expected ${step.expect}`,
    );
  }
}

/** Run every step for one registry in a fresh scratch directory, stopping at the first failure. */
export async function verifyRelease(
  target: VerifyTarget,
  version: string,
  options: VerificationOptions = {},
): Promise<void> {
  const resolved = options.wheel === undefined ? options : { wheel: path.resolve(options.wheel) };
  const steps = await verificationSteps(target, version, resolved);
  const directory = await mkdtemp(path.join(tmpdir(), `workhorse-release-verify-${target}-`));
  try {
    for (const step of steps) await runStep(step, directory);
    process.stdout.write(`Verified ${target} ${version}\n`);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function isTarget(value: string | undefined): value is VerifyTarget {
  return value === "crate" || value === "go" || value === "npm" || value === "python";
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [target, version, flag, wheel] = process.argv.slice(2);
  const wheelFlag = flag === "--wheel" && wheel !== undefined;
  if (!isTarget(target) || !version || (flag !== undefined && !wheelFlag)) {
    process.stderr.write(
      "Usage: pnpm release:verify <python|npm|crate|go> <X.Y.Z> [--wheel <path>]\n",
    );
    process.exitCode = 64;
  } else {
    try {
      await verifyRelease(target, version, wheelFlag ? { wheel } : {});
    } catch (error) {
      process.stderr.write(`Release verification failed: ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  }
}
