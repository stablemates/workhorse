import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Evaluate the real launchers with process creation replaced: no demo process or database starts.
async function launchPlan(path: string, secondary?: string) {
  const launches: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const source = (await readFile(path, "utf8")).replace(
    'import { spawn } from "node:child_process";',
    "",
  );
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  await runInNewContext(`(async () => { ${code} })()`, {
    process: {
      env: {
        DATABASE_URL_PRIMARY: "postgres://primary/demo",
        ...(secondary ? { DATABASE_URL_SECONDARY: secondary } : {}),
      },
      execPath: "node",
      platform: "linux",
      on() {},
      once() {},
    },
    console: { log() {} },
    setTimeout: () => ({ unref() {} }),
    clearTimeout() {},
    spawn(command: string, args: string[], options: { env: NodeJS.ProcessEnv }) {
      launches.push({ command, args, env: options.env });
      return {
        exitCode: 0,
        signalCode: null,
        kill() {},
        once(event: string, callback: (code: number, signal: null) => void) {
          if (event === "exit") queueMicrotask(() => callback(0, null));
        },
      };
    },
  });
  return launches;
}

describe.each(["scripts/dev.ts", "typescript/demo/container-entrypoint.mjs"])("%s", (path) => {
  it("starts exactly one isolated staging worker only when its database exists", async () => {
    const primaryOnly = await launchPlan(path);
    expect(primaryOnly).toHaveLength(4);
    const withStaging = await launchPlan(path, "postgres://secondary/staging");
    expect(withStaging).toHaveLength(5);
    const staging = withStaging.filter(({ env }) => env.WORKHORSE_DEMO_WORKSPACE === "staging");
    expect(staging).toHaveLength(1);
    expect(staging[0]!.env).toMatchObject({
      DATABASE_URL_PRIMARY: "postgres://secondary/staging",
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-staging",
    });
    expect(
      withStaging
        .slice(0, 4)
        .every(({ env }) => env.DATABASE_URL_PRIMARY === "postgres://primary/demo"),
    ).toBe(true);
    expect(staging[0]!.args).toEqual(withStaging[1]!.args);
  });
});
