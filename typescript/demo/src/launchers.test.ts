import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Evaluate the real launchers with process creation replaced: no demo process or database starts.
async function launchPlan(
  path: string,
  secondary?: string,
  {
    serverAnswers = true,
    primary = "postgres://primary/demo",
  }: { serverAnswers?: boolean; primary?: string } = {},
) {
  const launches: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  // How many processes had started when the launcher first asked the server for `/up`.
  const launchedAtFirstHealthCheck: number[] = [];
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
        DATABASE_URL_PRIMARY: primary,
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
    AbortSignal,
    async fetch() {
      launchedAtFirstHealthCheck.push(launches.length);
      if (!serverAnswers) throw new Error("connection refused");
      return { ok: true };
    },
    spawn(command: string, args: string[], options: { env: NodeJS.ProcessEnv }) {
      launches.push({ command, args, env: options.env });
      return {
        exitCode: 0,
        signalCode: null,
        kill() {},
        once(event: string, callback: (code: number, signal: null) => void) {
          // A macrotask, so a process outlives the launcher's first health check. A server that
          // does not answer exits first, and the launcher must then start nothing else.
          if (event === "exit") setImmediate(() => callback(0, null));
        },
      };
    },
  });
  return { launches, launchedAtFirstHealthCheck };
}

describe.each(["scripts/dev.ts", "typescript/demo/container-entrypoint.mjs"])("%s", (path) => {
  it("starts exactly one isolated staging worker only when its database exists", async () => {
    const { launches: primaryOnly } = await launchPlan(path);
    expect(primaryOnly).toHaveLength(8);
    const { launches: withStaging } = await launchPlan(path, "postgres://secondary/staging");
    expect(withStaging).toHaveLength(9);
    const staging = withStaging.filter(({ env }) => env.WORKHORSE_DEMO_WORKSPACE === "staging");
    expect(staging).toHaveLength(1);
    expect(staging[0]!.env).toMatchObject({
      DATABASE_URL_PRIMARY:
        "postgres://secondary/staging?application_name=workhorse-demo-worker-staging",
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-staging",
    });
    expect(
      withStaging
        .slice(0, 8)
        .every(({ env }) => env.DATABASE_URL_PRIMARY?.startsWith("postgres://primary/demo?")),
    ).toBe(true);
    expect(staging[0]!.args).toEqual(withStaging[1]!.args);
  });

  // `pg_stat_activity` must name the process of each session, for example the one that holds
  // `LISTEN workhorse_tasks` (SM-1819).
  it("connects each process under its service name and keeps the other URL parameters", async () => {
    const { launches } = await launchPlan(
      path,
      "postgres://secondary/staging?sslmode=disable#note",
      {
        primary:
          "postgres://user:p%2Bw@/demo?host=/run/postgresql&application_name=operator&options=-c%20statement_timeout%3D0",
      },
    );
    for (const { env } of launches) {
      const name = env.WORKHORSE_DEMO_SERVICE_NAME ?? "workhorse-demo-server";
      const suffix = `application_name=${name}`;
      const secondary = `postgres://secondary/staging?sslmode=disable&${suffix}#note`;
      const primary =
        env.WORKHORSE_DEMO_WORKSPACE === "staging"
          ? secondary
          : `postgres://user:p%2Bw@/demo?host=/run/postgresql&options=-c%20statement_timeout%3D0&${suffix}`;
      expect(env.DATABASE_URL_PRIMARY).toBe(primary);
      expect(env.DATABASE_URL_SECONDARY).toBe(secondary);
    }
    expect(new Set(launches.map(({ env }) => env.DATABASE_URL_PRIMARY)).size).toBe(launches.length);
  });
});

/** The service name of each process a launcher starts, in start order. */
async function serviceNames(path: string) {
  const { launches } = await launchPlan(path, "postgres://secondary/staging");
  return launches.map(({ env }) => env.WORKHORSE_DEMO_SERVICE_NAME ?? "workhorse-demo-server");
}

describe("both demo launchers", () => {
  it("start the same workers under the same service names", async () => {
    const development = await serviceNames("scripts/dev.ts");
    expect(await serviceNames("typescript/demo/container-entrypoint.mjs")).toEqual(development);
    expect(development).toEqual(
      expect.arrayContaining(["workhorse-demo-worker-jvm", "workhorse-demo-worker-dotnet"]),
    );
  });
});

// The deploy waits for the server's `/up`, and the container has one CPU. Workers that start
// alongside the server made that check wait for their startup too (SM-859).
describe("typescript/demo/container-entrypoint.mjs start order", () => {
  const entrypoint = "typescript/demo/container-entrypoint.mjs";

  it("starts the server alone and the workers once it answers /up", async () => {
    const { launches, launchedAtFirstHealthCheck } = await launchPlan(
      entrypoint,
      "postgres://secondary/staging",
    );
    expect(launchedAtFirstHealthCheck[0]).toBe(1);
    expect(launches[0]!.env.WORKHORSE_DEMO_SERVICE_NAME).toBe("workhorse-demo-server");
    expect(launches).toHaveLength(9);
  });

  it("starts no worker when the server exits before it answers", async () => {
    const { launches } = await launchPlan(entrypoint, "postgres://secondary/staging", {
      serverAnswers: false,
    });
    expect(launches.map(({ env }) => env.WORKHORSE_DEMO_SERVICE_NAME)).toEqual([
      "workhorse-demo-server",
    ]);
  });
});
