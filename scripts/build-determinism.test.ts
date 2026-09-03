import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

/**
 * A build that emits into `dist/` must be a pure function of its sources.
 *
 * `api/typescript.txt` and `api/cli.txt` are read from the emitted `.d.ts` under `dist/`, because
 * ADR 0054 governs the shipped declarations rather than the sources behind them. tsc does not
 * promise a stable property order for an inferred anonymous object type: the order follows the
 * order the checker created the types, and reusing a `.tsbuildinfo` changes it. So the same commit
 * emits one order on a cold build and another on a warm one, and whoever regenerates a snapshot
 * from a warm cache commits bytes that CI, which always builds clean, rejects.
 *
 * That is not hypothetical. It turned `main` red at `e915404b`: `pnpm typescript-api:check` failed
 * with every line still present and only their order moved, and the release train stopped behind it.
 *
 * Incremental typechecking is untouched. `tsconfig.typecheck-base.json` sets `composite` and
 * `incremental` and emits into `.build/typecheck`, which nothing ships and no snapshot reads.
 */

/** A tsconfig that emits declarations into a `dist` directory, with its inherited options. */
interface EmittingConfig {
  readonly file: string;
  readonly options: ts.CompilerOptions;
}

async function trackedConfigs(): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "-z", "*tsconfig*.json"], {
    encoding: "utf8",
  });
  return stdout.split("\0").filter(Boolean);
}

/** Resolve one tsconfig the way tsc does, so an inherited `incremental` is caught too. */
function resolve(file: string): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(file, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
    },
  } as ts.ParseConfigFileHost);
  if (!parsed) throw new Error(`${file} did not parse`);
  return parsed.options;
}

/** Every tracked tsconfig that actually emits declarations into a `dist` directory. */
async function emittingConfigs(): Promise<EmittingConfig[]> {
  const configs: EmittingConfig[] = [];
  for (const file of await trackedConfigs()) {
    const options = resolve(file);
    if (options.noEmit || !options.declaration) continue;
    const outDir = options.outDir ?? "";
    if (!outDir.split(path.sep).includes("dist")) continue;
    configs.push({ file, options });
  }
  return configs;
}

describe("builds that emit shipped declarations", () => {
  it("covers every package whose declarations a snapshot or a tarball carries", async () => {
    const files = (await emittingConfigs()).map((config) => config.file).toSorted();

    // Named rather than counted, so adding a package that emits into `dist` fails here and its
    // author has to decide whether the rule applies to it rather than silently widening the set.
    expect(files).toEqual(
      [
        "dashboard/app/tsconfig.json",
        "tsconfig.build.json",
        "tsconfig.json",
        "typescript/dashboard-server/tsconfig.json",
        "typescript/demo/tsconfig.json",
        "typescript/drizzle/tsconfig.json",
        "typescript/kysely/tsconfig.json",
        "typescript/otel/tsconfig.json",
        "typescript/prisma/tsconfig.json",
        "typescript/typeorm/tsconfig.json",
      ].toSorted(),
    );
  });

  it("reuses no build cache, so a warm checkout emits what a clean one emits", async () => {
    const offenders = (await emittingConfigs())
      .filter((config) => config.options.incremental === true || config.options.composite === true)
      .map((config) => config.file);

    expect(offenders).toEqual([]);
  });

  it("names no build info file, which tsc accepts only alongside a build cache", async () => {
    const offenders: string[] = [];
    for (const config of await emittingConfigs()) {
      const contents = await readFile(config.file, "utf8");
      if (contents.includes("tsBuildInfoFile")) offenders.push(config.file);
    }

    expect(offenders).toEqual([]);
  });
});
