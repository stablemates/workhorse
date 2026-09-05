/**
 * Record one agent documentation eval session.
 *
 * Usage: pnpm agent-eval:record <task> [--run <name>] [--model <id>]
 *
 * This drives the `claude` CLI, which authenticates from the maintainer's own login rather than
 * from an API key. It needs that login and the network, so it can never be a CI job: ADR 0043
 * states that CI receives no secrets, and a login is a credential like any other. A maintainer
 * runs it on demand, before and after a documentation change, and commits the fixture it writes.
 * Scoring the fixture afterwards needs neither the login nor the network.
 *
 * The session is fetch-only. It gets one tool, one start URL, and a fetch budget; it never
 * searches, and every other URL must be reached by following a link. The harness performs every
 * fetch, which is why the transcript can carry each fetch's status, content type and byte count,
 * and it keeps no response body.
 *
 * `session.ts` holds the options that keep the session inside that tool, and a test reads them.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { documentationHost, fetchBudget, taskById, taskText } from "./tasks.js";
import { parseStream, producedText, sessionArguments } from "./session.js";
import {
  formatTranscript,
  sessionsRoot,
  type Transcript,
  type TranscriptFetch,
  transcriptFileName,
} from "./transcript.js";

const defaultModel = "claude-opus-5";

function runClaude(
  cwd: string,
  args: readonly string[],
  prompt: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    // The login is the CLI's own. An inherited key would bill a different account and could run a
    // different model, so it is removed rather than trusted to be absent.
    const { ANTHROPIC_API_KEY: _ignored, ...environment } = process.env;
    const child = spawn("claude", args, {
      cwd,
      // A documentation page must reach the session whole. The CLI truncates a tool result past
      // MAX_MCP_OUTPUT_TOKENS, which defaults to 25,000, and spills the rest to a file whose path
      // it names. The fetch server refuses that path, so a truncated page costs the session
      // content but never a fetch.
      env: { ...environment, MAX_MCP_OUTPUT_TOKENS: "200000" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(prompt);
  });
}

async function run(taskId: string, runName: string, model: string): Promise<void> {
  const task = taskById(taskId);

  // The session runs here, not in the checkout. A `CLAUDE.md` at or above the working directory
  // would reach it whatever the settings flags say, and this repository's own instructions would
  // then be part of what the eval measures.
  const scratch = await mkdtemp(path.join(tmpdir(), "agent-eval-"));
  const fetchLog = path.join(scratch, "fetches.jsonl");
  await writeFile(fetchLog, "");

  const mcpConfig = path.join(scratch, "mcp.json");
  await writeFile(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        agent_eval: {
          // Absolute, because the session's working directory is outside the checkout and the
          // CLI's inherited `PATH` is not something this recorder should depend on.
          command: path.resolve(import.meta.dirname, "../../node_modules/.bin/tsx"),
          args: [path.join(import.meta.dirname, "fetch-server.ts")],
          env: {
            AGENT_EVAL_FETCH_LOG: fetchLog,
            AGENT_EVAL_FETCH_BUDGET: String(fetchBudget),
          },
        },
      },
    }),
  );

  const prompt = [taskText, `Write it in ${task.language}.`, `Start here: ${task.startUrl}`].join(
    "\n\n",
  );

  const result = await runClaude(scratch, sessionArguments({ model, mcpConfig }), prompt);
  const events = parseStream(result.stdout);

  if (events.length === 0) {
    await rm(scratch, { recursive: true, force: true });
    throw new Error(
      `The CLI produced no stream events (exit ${String(result.code)}). stderr: ${result.stderr.trim()}`,
    );
  }

  const fetches: TranscriptFetch[] = (await readFile(fetchLog, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TranscriptFetch);

  const transcriptText = producedText(events);
  await rm(scratch, { recursive: true, force: true });

  const directory = path.join(sessionsRoot, runName, task.id.toLowerCase());
  await mkdir(directory, { recursive: true });

  const transcript: Transcript = {
    task: task.id,
    language: task.language,
    run: runName,
    recordedAt: new Date().toISOString().slice(0, 10),
    model,
    provenance: "recorded",
    fetches,
    install: [],
    mistakes: {
      enqueueOutsideTransaction: "clean",
      schemaOnRuntimePath: "clean",
      effectOutsideCheckpoint: "clean",
    },
    produced: ["produced.md"],
  };

  await writeFile(path.join(directory, transcriptFileName), formatTranscript(transcript));
  await writeFile(path.join(directory, "produced.md"), `${transcriptText}\n`);

  process.stdout.write(
    [
      `Recorded task ${task.id} into ${path.relative(process.cwd(), directory)}.`,
      `  ${fetches.length} fetches against ${documentationHost} and elsewhere.`,
      "",
      "Before committing this fixture, fill in by hand:",
      "  - install: one entry per install command the session produced, with its registry verdict.",
      "  - mistakes: the maintainer's read of each of the three known mistakes.",
      "Both are the recorded judgement the note cites; `score` reports them beside the program's own",
      "signals and fails when the two disagree.",
      "",
    ].join("\n"),
  );
}

const [taskArgument, ...rest] = process.argv.slice(2);
if (taskArgument === undefined) {
  process.stderr.write("Usage: pnpm agent-eval:record <task> [--run <name>] [--model <id>]\n");
  process.exit(2);
}
const runFlag = rest.indexOf("--run");
const modelFlag = rest.indexOf("--model");
await run(
  taskArgument,
  (runFlag === -1 ? undefined : rest[runFlag + 1]) ??
    `${new Date().toISOString().slice(0, 10)}-run`,
  (modelFlag === -1 ? undefined : rest[modelFlag + 1]) ?? defaultModel,
);
