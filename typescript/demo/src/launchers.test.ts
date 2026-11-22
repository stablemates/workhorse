import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { readLines } from "../console-lines.cjs";

function nextTurn() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

// Evaluate the real launchers with process creation replaced: no demo process or database starts.
async function launchPlan(
  path: string,
  secondary?: string,
  {
    serverAnswers = true,
    primary = "postgres://primary/demo",
    keepRunning = false,
    environment = {},
    stdout,
    onKill,
    onSpawn,
    onHealthCheck,
  }: {
    serverAnswers?: boolean;
    primary?: string;
    // Each process runs until the launcher stops it, rather than exiting at once.
    keepRunning?: boolean;
    environment?: NodeJS.ProcessEnv;
    stdout?: { on(event: string, listener: () => void): void; write?(text: string): boolean };
    onKill?: () => void;
    onSpawn?: () => void;
    // Runs when the launcher asks the server for `/up`, before the answer.
    onHealthCheck?: () => void;
  } = {},
) {
  const launches: {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    stdio: unknown;
  }[] = [];
  // The output streams of each process, by service name.
  const streams = new Map<string, { stdout: PassThrough; stderr: PassThrough }>();
  // How many processes had started when the launcher first asked the server for `/up`.
  const launchedAtFirstHealthCheck: number[] = [];
  // The sandbox gives the launcher its imports, so remove every import statement.
  const source = (await readFile(path, "utf8")).replaceAll(/^import [^;]+;$/gm, "");
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  await runInNewContext(`(async () => { ${code} })()`, {
    process: {
      env: {
        DATABASE_URL_PRIMARY: primary,
        ...(secondary ? { DATABASE_URL_SECONDARY: secondary } : {}),
        ...environment,
      },
      stdout,
      execPath: "node",
      platform: "linux",
      on() {},
      once() {},
    },
    console: { log() {}, error() {} },
    // The console files of `scripts/dev.ts`: no file opens.
    RotatingFile: class {
      append() {
        return Promise.resolve();
      }
      flush() {
        return Promise.resolve();
      }
    },
    demoLogFile: () => ({}),
    readLines,
    resolvePath: (...segments: string[]) => {
      const joined = segments.join("/");
      return joined.startsWith("/") ? joined : `/repository/${joined}`;
    },
    setImmediate,
    setTimeout: () => ({ unref() {} }),
    clearTimeout() {},
    AbortSignal,
    async fetch() {
      launchedAtFirstHealthCheck.push(launches.length);
      onHealthCheck?.();
      if (!serverAnswers) throw new Error("connection refused");
      return { ok: true };
    },
    spawn(command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: unknown }) {
      launches.push({ command, args, env: options.env, stdio: options.stdio });
      onSpawn?.();
      const service = options.env.WORKHORSE_DEMO_SERVICE_NAME ?? "dashboard";
      const output = { stdout: new PassThrough(), stderr: new PassThrough() };
      streams.set(service, output);
      return {
        ...output,
        exitCode: keepRunning ? null : 0,
        signalCode: null,
        kill() {
          onKill?.();
        },
        once(event: string, callback: (code: number, signal: null) => void) {
          // A macrotask, so a process outlives the launcher's first health check. A server that
          // does not answer exits first, and the launcher must then start nothing else.
          if (event === "exit" && !keepRunning) setImmediate(() => callback(0, null));
        },
      };
    },
  });
  return { launches, launchedAtFirstHealthCheck, streams };
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

  it("stops every process when its console output fails", async () => {
    let fail: (() => void) | undefined;
    let spawned = 0;
    let kills = 0;
    // The processes run on, so the launch plan does not settle.
    void launchPlan(path, undefined, {
      keepRunning: true,
      stdout: {
        on(event, listener) {
          if (event === "error") fail = listener;
        },
      },
      onSpawn: () => {
        spawned += 1;
      },
      onKill: () => {
        kills += 1;
      },
    });
    // The launch plan reads and transpiles the launcher before it runs it, and the container
    // entry point starts the workers after the server answers.
    await vi.waitFor(() => expect(spawned).toBe(8));
    expect(kills).toBe(0);
    fail!();
    expect(kills).toBe(8);
  });

  it("pipes the output of each process so that it can name the process", async () => {
    const { launches } = await launchPlan(path);
    for (const launch of launches) expect(launch.stdio).toEqual(["inherit", "pipe", "pipe"]);
  });

  it("stops a process while the console is full", async () => {
    const output = Object.assign(new EventEmitter(), { write: () => false });
    const { streams } = await launchPlan(path, undefined, { stdout: output });
    const python = streams.get("workhorse-demo-worker-python")!.stdout;
    python.write("line\n".repeat(20));
    await nextTurn();
    expect(python.isPaused()).toBe(true);
    expect(output.listenerCount("drain")).toBe(1);
  });

  it("writes each line with the short name of its process in front", async () => {
    const written: string[] = [];
    const { streams } = await launchPlan(path, "postgres://secondary/staging", {
      stdout: { on() {}, write: (text) => (written.push(text), true) },
    });
    streams.get("workhorse-demo-worker-python")!.stdout.write("Worker started\n");
    await nextTurn();
    streams.get("workhorse-demo-worker-typescript")!.stdout.end("Task completed");
    await nextTurn();
    // The widest name, `typescript`, sets the width of the name column.
    expect(written).toEqual(["python     | Worker started\n", "typescript | Task completed\n"]);
  });
});

/** The service name of each process a launcher starts, in start order. */
async function serviceNames(path: string) {
  const { launches } = await launchPlan(path, "postgres://secondary/staging");
  return launches.map(({ env }) => env.WORKHORSE_DEMO_SERVICE_NAME ?? "workhorse-demo-server");
}

describe("scripts/dev.ts log directory", () => {
  it("names the repository log directory for every process", async () => {
    const { launches } = await launchPlan("scripts/dev.ts");
    expect(launches.map(({ env }) => env.WORKHORSE_DEMO_LOG_DIRECTORY)).toEqual(
      launches.map(() => "/repository/logs"),
    );
  });

  it("gives every process one absolute directory for a relative override", async () => {
    const { launches } = await launchPlan("scripts/dev.ts", undefined, {
      environment: { WORKHORSE_DEMO_LOG_DIRECTORY: "review-logs" },
    });
    expect(new Set(launches.map(({ env }) => env.WORKHORSE_DEMO_LOG_DIRECTORY))).toEqual(
      new Set(["/repository/review-logs"]),
    );
  });
});

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

  it("starts no worker when the stop comes while the server answers", async () => {
    let fail: (() => void) | undefined;
    const { launches } = await launchPlan(entrypoint, "postgres://secondary/staging", {
      stdout: {
        on(event, listener) {
          if (event === "error") fail = listener;
        },
      },
      onHealthCheck: () => fail!(),
    });
    expect(launches.map(({ env }) => env.WORKHORSE_DEMO_SERVICE_NAME)).toEqual([
      "workhorse-demo-server",
    ]);
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
