// Runs each `durable-script` fixture that has a `handOff` step across two SDKs (SM-1950). SDK A
// runs the task to its first suspension, and SDK B replays it to the end, on one database. Each
// SDK runner exposes the two phases through one entry point, and CROSS_SDK_PAIRS chooses the pairs.
//
//   tsx scripts/with-env.ts tsx scripts/cross-sdk-replay.ts [--pair <a>:<b>]...
//
// Without `--pair`, the script runs every pair of CROSS_SDK_PAIRS. The Go CI job runs it, because
// that job has the toolchains of both SDKs of the default pairs.
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDatabaseTestHarness } from "../typescript/core/test/support/db.js";
import {
  runDurableScriptPhase,
  type DurableScriptPhase,
} from "../typescript/core/test/support/durable-script.js";
import { repositoryRoot } from "./packages.js";
import {
  loadSqlProtocolFixtures,
  type DurableScriptRuntimeFixture,
} from "./verify-sql-protocol.js";
import { readPins, verifyTools } from "./verify-toolchain.js";

/** An SDK whose conformance runner exposes the two phases of a cross-SDK run. */
type CrossSdk = "typescript" | "go" | "python" | "rust" | "ruby" | "java" | "csharp";

/**
 * The pairs that a run without `--pair` runs, as [SDK A, SDK B]. TypeScript sends a timer target
 * and a child request with milliseconds, and Go sends the native values, so this pair differs most
 * in its encodings. Each direction is one pair.
 */
const CROSS_SDK_PAIRS: readonly (readonly [CrossSdk, CrossSdk])[] = [
  ["typescript", "go"],
  ["go", "typescript"],
];

/** The longest time that one phase of another SDK can run, with the build of its runner. */
const PHASE_TIMEOUT_MS = 15 * 60 * 1000;

interface PhaseCommand {
  /** The pinned tool that runs the command, which the script checks before it starts. */
  readonly tool: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * The entry point of each runner other than TypeScript. Each one runs one phase of one fixture and
 * reads `WORKHORSE_CROSS_SDK_PHASE`, `WORKHORSE_CROSS_SDK_FIXTURE`, and
 * `WORKHORSE_CROSS_SDK_DATABASE_URL`. The TypeScript phase runs in this process.
 */
const PHASE_COMMANDS: Record<Exclude<CrossSdk, "typescript">, PhaseCommand> = {
  go: {
    tool: "go",
    command: "go",
    args: ["test", "-count=1", "-run", "^TestCrossSDKDurableScriptPhase$", "."],
    cwd: "go",
  },
  python: {
    tool: "uv",
    command: "uv",
    args: [
      "run",
      "--project",
      "python",
      "pytest",
      "-q",
      "python/tests/test_worker_runtime_conformance.py::test_cross_sdk_durable_script_phase",
    ],
    cwd: ".",
  },
  rust: {
    tool: "cargo",
    command: "cargo",
    args: [
      "test",
      "--package",
      "workhorse",
      "--test",
      "protocol_conformance",
      "cross_sdk_durable_script_phase",
      "--",
      "--exact",
      "--nocapture",
    ],
    cwd: ".",
  },
  ruby: {
    tool: "ruby",
    command: "bundle",
    args: [
      "exec",
      "rspec",
      "spec/conformance/protocol_conformance_spec.rb",
      "-e",
      "runs one phase of a cross-SDK durable-script fixture",
    ],
    cwd: "ruby",
  },
  java: {
    tool: "gradle",
    command: "gradle",
    args: [
      "-p",
      "jvm",
      ":workhorse:test",
      "--tests",
      "run.workhorse.conformance.CrossSdkPhaseTest",
      // Gradle does not track the environment, so a test that ran before is up to date.
      "--rerun",
      "-x",
      ":workhorse:testWithoutOpenTelemetry",
    ],
    cwd: ".",
  },
  csharp: {
    tool: "dotnet",
    command: "dotnet",
    args: [
      "run",
      "--project",
      "dotnet/tests/Workhorse.Tests",
      "--",
      "-class",
      "Workhorse.Tests.Conformance.CrossSdkPhaseTests",
    ],
    cwd: ".",
  },
};

async function runPhase(options: {
  sdk: CrossSdk;
  phase: Exclude<DurableScriptPhase, "all">;
  fixture: DurableScriptRuntimeFixture;
  databaseUrl: string;
  pool: Parameters<typeof runDurableScriptPhase>[0]["pool"];
}): Promise<void> {
  const { sdk, phase, fixture, databaseUrl, pool } = options;
  if (sdk === "typescript") {
    // The phase runs in this process, so a runOnce() that never settles cannot be stopped. The
    // harness then ends the process with an error.
    const timer = setTimeout(() => {
      console.error(`the ${phase} phase of ${fixture.id} did not end in typescript`);
      process.exit(1);
    }, PHASE_TIMEOUT_MS);
    try {
      await runDurableScriptPhase({ pool, fixture, phase });
    } finally {
      clearTimeout(timer);
    }
    return;
  }
  const entry = PHASE_COMMANDS[sdk];
  const status = await new Promise<number>((resolve, reject) => {
    const child = spawn(entry.command, [...entry.args], {
      cwd: path.join(repositoryRoot, entry.cwd),
      env: {
        ...process.env,
        WORKHORSE_CROSS_SDK_PHASE: phase,
        WORKHORSE_CROSS_SDK_FIXTURE: fixture.id,
        WORKHORSE_CROSS_SDK_DATABASE_URL: databaseUrl,
      },
      stdio: "inherit",
      // The phase gets a process group of its own, so the timeout also stops the test process
      // that the launcher starts, such as the test executable of `cargo test`.
      detached: true,
    });
    // A build and one phase take minutes at most, so a phase that runs longer has stopped.
    const timer = setTimeout(() => {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    }, PHASE_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  if (status !== 0) {
    throw new Error(`the ${phase} phase of ${fixture.id} failed in ${sdk} with exit ${status}`);
  }
}

async function expectFinalRows(
  pool: Parameters<typeof runDurableScriptPhase>[0]["pool"],
  fixture: DurableScriptRuntimeFixture,
): Promise<void> {
  const last = fixture.steps.findLast((step) => step.action === "expect");
  if (last?.action !== "expect") throw new Error(`${fixture.id} has no expect step`);
  const rows = await pool.query<{ id: string }>(
    "SELECT id::text AS id FROM workhorse.task WHERE task_type = $1",
    [fixture.taskType],
  );
  const taskId = rows.rows[0]?.id;
  if (taskId === undefined) throw new Error(`${fixture.id}: no ${fixture.taskType} task`);
  const observed = await pool.query<{ observed: string }>(fixture.observe, [taskId]);
  const actual: unknown = JSON.parse(observed.rows[0]?.observed ?? "null");
  if (!isDeepStrictEqual(actual, last.observed)) {
    throw new Error(
      `${fixture.id}: after the replay, observed ${JSON.stringify(actual)}, expected ${JSON.stringify(last.observed)}`,
    );
  }
}

function parsePairs(argv: readonly string[]): (readonly [CrossSdk, CrossSdk])[] {
  const sdks = new Set<string>(["typescript", ...Object.keys(PHASE_COMMANDS)]);
  const isSdk = (value: string | undefined): value is CrossSdk =>
    value !== undefined && sdks.has(value);
  const pairs: (readonly [CrossSdk, CrossSdk])[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--pair") throw new Error(`unknown argument ${argv[index]}`);
    const [first, second, ...rest] = (argv[index + 1] ?? "").split(":");
    if (!isSdk(first) || !isSdk(second) || rest.length > 0) {
      throw new Error(`--pair needs <sdk>:<sdk>, one of ${[...sdks].join(", ")}`);
    }
    pairs.push([first, second]);
    index += 1;
  }
  return pairs.length > 0 ? pairs : [...CROSS_SDK_PAIRS];
}

async function main(argv: readonly string[]): Promise<number> {
  const pairs = parsePairs(argv);
  const tools = [
    ...new Set(
      pairs.flat().flatMap((sdk) => (sdk === "typescript" ? [] : [PHASE_COMMANDS[sdk].tool])),
    ),
  ];
  const refusals = await verifyTools(
    tools.map((tool) => ({ tool, executable: tool })),
    { mode: "identity", pins: await readPins(repositoryRoot), checkoutRoot: repositoryRoot },
  );
  if (refusals.length > 0) {
    console.error(refusals.join("\n\n"));
    return 2;
  }
  const fixtures = (await loadSqlProtocolFixtures(repositoryRoot)).runtime.filter(
    (fixture): fixture is DurableScriptRuntimeFixture =>
      fixture.kind === "durable-script" && fixture.steps.some((step) => step.action === "handOff"),
  );
  if (fixtures.length === 0) throw new Error("no durable-script fixture has a handOff step");
  const database = createDatabaseTestHarness(import.meta.url, { max: 4 });
  await database.setup();
  try {
    for (const [first, second] of pairs) {
      for (const fixture of fixtures) {
        await database.reset();
        const shared = { fixture, databaseUrl: database.databaseUrl, pool: database.pool };
        await runPhase({ ...shared, sdk: first, phase: "suspend" });
        await runPhase({ ...shared, sdk: second, phase: "replay" });
        // A skipped test also exits 0, so the harness reads the rows of the last step itself.
        await expectFinalRows(database.pool, fixture);
        console.log(`${fixture.id}: ${first} suspended the task and ${second} replayed it`);
      }
    }
  } finally {
    await database.teardown();
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
