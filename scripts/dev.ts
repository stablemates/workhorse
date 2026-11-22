import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import type { Readable } from "node:stream";
import { readLines } from "../typescript/demo/console-lines.cjs";
import { RotatingFile, demoLogFile } from "../typescript/demo/file-log-exporter.cjs";

const usesProcessGroups = process.platform !== "win32";
const forceKillAfterMs = 5_000;
// How long a process group may outlive the force kill before the supervisor stops waiting for it.
const processGroupGiveUpAfterMs = 1_000;
const processGroupPollMs = 25;

const publicPort = Number(process.env.PORT ?? 3000);
const dashboardDevPort = Number(process.env.WORKHORSE_DASHBOARD_DEV_PORT ?? 4173);
const mode = process.env.WORKHORSE_DEMO_MODE ?? "development";
const logEnvironment = process.env.WORKHORSE_DEMO_ENV ?? "development";
// Every demo worker writes `<directory>/<environment>/<service>.ndjson`. The Node processes default
// to the repository's `logs/` directory; the other workers write a file only when this is set.
// The value is absolute, because the commands start in different directories, such as `go -C go`.
const logDirectory = resolvePath(process.env.WORKHORSE_DEMO_LOG_DIRECTORY ?? "logs");
const serverScript = mode === "production" ? "start" : "dev:server";
const typescriptWorkerScript = mode === "production" ? "start:worker" : "dev:worker";
// `workhorse-source` rather than the conventional `development`: bundlers apply `development`
// on their own, so a published package that named it would send a consumer's dev server to a
// `src/` directory the tarball does not contain. Only this repository asks for this condition.
const nodeOptions = [
  process.env.NODE_OPTIONS,
  ...(mode === "development" ? ["--conditions=workhorse-source"] : []),
]
  .filter((option): option is string => option !== undefined)
  .join(" ");
const commands: Array<{
  command: string;
  arguments: string[];
  env: NodeJS.ProcessEnv;
}> = [
  {
    command: "pnpm",
    // The silent reporter leaves out the script banner and the error that pnpm prints when a
    // signal stops the script. The supervisor reports an unexpected exit itself.
    arguments: ["--reporter=silent", "--filter", "@stablemates/workhorse-demo", serverScript],
    env: {
      ...process.env,
      PORT: String(publicPort),
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-server",
      NODE_OPTIONS: nodeOptions,
    },
  },
  {
    // Each demo worker owns a process and database client. PostgreSQL is their only shared state.
    command: "pnpm",
    arguments: [
      "--reporter=silent",
      "--filter",
      "@stablemates/workhorse-demo",
      typescriptWorkerScript,
    ],
    env: {
      ...process.env,
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-typescript",
      NODE_OPTIONS: nodeOptions,
    },
  },
  {
    command: "uv",
    arguments: ["run", "--project", "python", "python/examples/demo_worker.py"],
    env: {
      ...process.env,
      // A pipe makes standard output block-buffered, so each line would wait for a full buffer.
      PYTHONUNBUFFERED: "1",
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-python",
    },
  },
  {
    command: "go",
    arguments: ["-C", "go", "run", "./examples/demo-worker"],
    env: {
      ...process.env,
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-go",
    },
  },
  {
    command: "cargo",
    arguments: ["run", "--quiet", "-p", "workhorse-demo-worker"],
    env: {
      ...process.env,
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-rust",
    },
  },
  {
    command: "bundle",
    arguments: ["exec", "ruby", "ruby/examples/demo_worker.rb"],
    env: {
      ...process.env,
      BUNDLE_GEMFILE: "ruby/Gemfile",
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-ruby",
    },
  },
  {
    // Gradle runs a build in a daemon of its own session, so a JVM that Gradle starts misses the
    // signal to this child's process group. Gradle only builds the class path, and `exec` makes
    // the worker JVM this child.
    command: "sh",
    arguments: [
      "-c",
      'gradle --quiet -p jvm :examples:programs:demoWorkerClassPath && exec java -cp "jvm/examples/programs/build/demo-worker/*" run.workhorse.examples.programs.DemoWorkerProgram',
    ],
    env: {
      ...process.env,
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-jvm",
    },
  },
  {
    command: "dotnet",
    arguments: ["run", "--project", "dotnet/demo/Workhorse.DemoWorker"],
    env: {
      ...process.env,
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-dotnet",
    },
  },
];

if (process.env.DATABASE_URL_SECONDARY) {
  commands.push({
    command: "pnpm",
    arguments: [
      "--reporter=silent",
      "--filter",
      "@stablemates/workhorse-demo",
      typescriptWorkerScript,
    ],
    env: {
      ...process.env,
      DATABASE_URL_PRIMARY: process.env.DATABASE_URL_SECONDARY,
      WORKHORSE_DEMO_WORKSPACE: "staging",
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-staging",
      NODE_OPTIONS: nodeOptions,
    },
  });
}

/**
 * Optionally run the dashboard's own UI harness alongside the demo.
 *
 * The demo always serves the packaged bundle on the public port, so this adds a second view rather
 * than replacing the one a consumer would get. It is opt-in because someone looking at the demo
 * should not pay for a Vite dev server, and because two URLs for the same dashboard is a cost worth
 * choosing deliberately.
 */
if (mode === "development" && process.env.WORKHORSE_DEMO_DASHBOARD_DEV === "true") {
  commands.push({
    command: "pnpm",
    arguments: ["--reporter=silent", "--filter", "@stablemates/workhorse-dashboard", "dev"],
    env: {
      ...process.env,
      PORT: String(dashboardDevPort),
      WORKHORSE_DASHBOARD_API: `http://127.0.0.1:${publicPort}`,
      // Match what the demo itself records, so the same action is attributed identically
      // regardless of which of the two views an operator used.
      WORKHORSE_DASHBOARD_ACTOR: "local-demo",
      NODE_OPTIONS: nodeOptions,
    },
  });
}

const children: ReturnType<typeof spawn>[] = [];
let stopping = false;
let shutdownRequested = false;
let stoppedAt = 0;
let processGroupsLeftRunning = false;
let forceKillTimer: NodeJS.Timeout | undefined;

// Each child runs in its own process group, so a signal to the supervisor's group does not reach
// it. The supervisor must forward the signal, so it listens before it starts the first child.
// `package.json` starts this script with `node --import tsx`, not the `tsx` CLI: the CLI sends
// SIGKILL to a script that does not acknowledge a signal within about 60 ms, and a supervisor
// killed that way leaves every child running.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdownRequested = true;
    stop(signal);
  });
}

// Each process connects under its service name, so `pg_stat_activity` names the process that holds a
// session (SM-1819). The name replaces an `application_name` in the URL. The other parameters keep
// their text, because a form encoder writes a space as `+`, which libpq does not decode. A fragment
// stays last, so the driver does not read the name as fragment text.
function withApplicationName(url: string, name: string) {
  const hash = url.indexOf("#");
  const fragment = hash === -1 ? "" : url.slice(hash);
  const head = hash === -1 ? url : url.slice(0, hash);
  const start = head.indexOf("?");
  const parameters = start === -1 ? [] : head.slice(start + 1).split("&");
  const kept = parameters.filter(
    (pair) => pair !== "" && pair.split("=")[0] !== "application_name",
  );
  const base = start === -1 ? head : head.slice(0, start);
  return `${base}?${[...kept, `application_name=${encodeURIComponent(name)}`].join("&")}${fragment}`;
}

for (const { env } of commands) {
  env.WORKHORSE_DEMO_LOG_DIRECTORY = logDirectory;
  const name = env.WORKHORSE_DEMO_SERVICE_NAME;
  for (const variable of ["DATABASE_URL_PRIMARY", "DATABASE_URL_SECONDARY"]) {
    const url = env[variable];
    if (url && name) env[variable] = withApplicationName(url, name);
  }
}

/** The short name in front of each console line: `server`, `python`, `dashboard`, and so on. */
function label(env: NodeJS.ProcessEnv): string {
  const name = env.WORKHORSE_DEMO_SERVICE_NAME;
  return name ? name.replace(/^workhorse-demo-(worker-)?/, "") : "dashboard";
}

const labelWidth = Math.max(...commands.map(({ env }) => label(env).length));
const colors = [36, 33, 35, 32, 34, 91, 96, 93, 95, 92];
const colored = process.stdout?.isTTY === true && process.env.NO_COLOR === undefined;
const consoleFiles: RotatingFile[] = [];
const brokenOutputs = new Set<NodeJS.WriteStream>();

// A console that closes, such as a pipe to `head`, must not end the supervisor before it stops the
// children. The supervisor stops them and keeps reading their output into the console files.
for (const output of [process.stdout, process.stderr]) {
  output?.on("error", () => {
    brokenOutputs.add(output);
    stop("SIGTERM");
  });
}

/**
 * Prints each line of one child stream with the child's name in front, and appends it to the
 * child's `<service>.console.log` with a timestamp. The file keeps what the structured log does not
 * hold, such as compiler output and a crash.
 */
function forward(
  stream: Readable | null,
  name: string,
  output: NodeJS.WriteStream,
  file: RotatingFile,
  color: number,
  source: "stdout" | "stderr",
): void {
  if (!stream) return;
  const prefix = name.padEnd(labelWidth);
  const tag = colored ? `\u001b[${color}m${prefix}\u001b[0m | ` : `${prefix} | `;
  let batch: string[] = [];
  readLines(stream, output, (line) => {
    if (batch.length === 0) {
      setImmediate(() => {
        const lines = batch;
        batch = [];
        void file.append(lines).catch((error: unknown) => {
          console.error(`Could not write the demo console log ${name}`, error);
        });
      });
    }
    batch.push(`${new Date().toISOString()} ${source} ${line}\n`);
    // A full console stops the process, so it waits as it did when it wrote to the console itself.
    return brokenOutputs.has(output) || output.write(`${tag}${line}\n`);
  });
}

for (const [index, { command, arguments: arguments_, env }] of commands.entries()) {
  const name = label(env);
  const file = new RotatingFile(
    demoLogFile(
      env.WORKHORSE_DEMO_SERVICE_NAME ?? "workhorse-demo-dashboard",
      logEnvironment,
      ".console.log",
      env,
    ),
  );
  consoleFiles.push(file);
  const child = spawn(command, arguments_, {
    detached: usesProcessGroups,
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const color = colors[index % colors.length]!;
  forward(child.stdout, name, process.stdout, file, color, "stdout");
  forward(child.stderr, name, process.stderr, file, color, "stderr");
  child.once("exit", (code, signal) => {
    if (!stopping)
      console.error(`The demo ${name} process stopped (${signal ?? `exit code ${code}`})`);
  });
  children.push(child);
}

console.log(
  process.env.PORTLESS_URL
    ? `Workhorse demo development environment available at ${process.env.PORTLESS_URL}`
    : `Workhorse demo development environment available at http://localhost:${publicPort}`,
);
if (process.env.WORKHORSE_DEMO_DASHBOARD_DEV === "true") {
  console.log(
    `Dashboard UI harness (source, hot reload) at http://localhost:${dashboardDevPort}; the demo above still serves the packaged bundle`,
  );
}

function killProcessTree(child: (typeof children)[number], signal: NodeJS.Signals): void {
  if (usesProcessGroups && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the liveness check and the signal.
    }
  }
  child.kill(signal);
}

/**
 * Whether any process is still in the child's process group, including one not yet reaped.
 *
 * A command's own exit does not end its descendants. They share its process group, so the group
 * outlives the command until the last of them is reaped.
 */
function processGroupExists(child: (typeof children)[number]): boolean {
  if (!usesProcessGroups || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessGroup(child: (typeof children)[number]): Promise<void> {
  const deadline = stoppedAt + forceKillAfterMs + processGroupGiveUpAfterMs;
  while (processGroupExists(child)) {
    if (Date.now() >= deadline) {
      processGroupsLeftRunning = true;
      console.error(`Process group ${child.pid} still has running processes after SIGKILL`);
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, processGroupPollMs);
    });
  }
}

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  stoppedAt = Date.now();
  for (const child of children) killProcessTree(child, signal);
  forceKillTimer = setTimeout(() => {
    for (const child of children) {
      const running = child.exitCode === null && child.signalCode === null;
      if (running || processGroupExists(child)) killProcessTree(child, "SIGKILL");
    }
  }, forceKillAfterMs);
  forceKillTimer.unref();
}

const exitCodes = await Promise.all(
  children.map(
    (child) =>
      new Promise<number>((resolve) => {
        child.once("error", (error) => {
          console.error(error);
          stop("SIGTERM");
          resolve(1);
        });
        child.once("exit", (code, signal) => {
          if (!stopping) stop("SIGTERM");
          // Report the stop only once the command's descendants have exited too.
          void waitForProcessGroup(child).then(() => resolve(code ?? (signal ? 1 : 0)));
        });
      }),
  ),
);

if (forceKillTimer) clearTimeout(forceKillTimer);
await Promise.all(consoleFiles.map((file) => file.flush()));
if (processGroupsLeftRunning) process.exitCode = 1;
else process.exitCode = shutdownRequested ? 0 : (exitCodes.find((code) => code !== 0) ?? 0);
