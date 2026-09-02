/**
 * Record one agent documentation eval session.
 *
 * Usage: pnpm agent-eval:record <task> [--run <name>] [--model <id>]
 *
 * This needs a model key and the network, so it can never be a CI job: ADR 0043 states that CI
 * receives no secrets. A maintainer runs it on demand, before and after a documentation change,
 * and commits the fixture it writes. Scoring the fixture afterwards needs neither.
 *
 * The session is fetch-only. It gets one tool, one start URL, and a fetch budget; it never
 * searches, and every other URL must be reached by following a link. The transcript keeps each
 * fetch's URL, status, content type and byte count, and no response body.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { documentationHost, fetchBudget, taskById, taskText } from "./tasks.js";
import {
  formatTranscript,
  sessionsRoot,
  type Transcript,
  type TranscriptFetch,
  transcriptFileName,
} from "./transcript.js";

const defaultModel = "claude-opus-5";

const systemPrompt = [
  "You are integrating a third-party library into an application you are helping someone build.",
  "You may only read documentation by calling fetch_url. You have no repository checkout, no web",
  "search, and no prior knowledge of this library that you did not read this session.",
  `You may make at most ${fetchBudget} fetches.`,
  "Reach every URL by following a link you have read, except the one you were given to start.",
  "When you are done, output the complete code the application needs, in one message, and then",
  "list every install command the reader must run, one per line, in a fenced block labelled",
  "'install'.",
].join(" ");

const fetchTool: Anthropic.Tool = {
  name: "fetch_url",
  description:
    "Fetch one URL and return its body as text. Returns the status when the fetch is not 2xx.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The absolute URL to fetch." },
      purpose: {
        type: "string",
        enum: ["read", "signature"],
        description:
          "Use 'signature' when the fetch is to learn an SDK name or type rather than to read guidance.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

interface FetchOutcome {
  readonly record: TranscriptFetch;
  readonly body: string;
}

async function fetchOnce(url: string, purpose: string | undefined): Promise<FetchOutcome> {
  try {
    const response = await globalThis.fetch(url, { redirect: "follow" });
    const body = await response.text();
    return {
      record: {
        url,
        status: response.status,
        ...(purpose === "signature" ? { purpose: "signature" as const } : {}),
        contentType: response.headers.get("content-type") ?? "unknown",
        bytes: Buffer.byteLength(body),
      },
      body: response.ok ? body : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      record: {
        url,
        status: null,
        ...(purpose === "signature" ? { purpose: "signature" as const } : {}),
        note: `fetch failed: ${(error as Error).message}`,
      },
      body: `The fetch failed: ${(error as Error).message}`,
    };
  }
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function run(taskId: string, runName: string, model: string): Promise<void> {
  const task = taskById(taskId);
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        `${taskText}`,
        `Write it in ${task.language}.`,
        `Start here: ${task.startUrl}`,
      ].join("\n\n"),
    },
  ];
  const fetches: TranscriptFetch[] = [];
  let transcriptText = "";

  while (fetches.length <= fetchBudget) {
    const response = await client.messages.create({
      model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: systemPrompt,
      tools: [fetchTool],
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      transcriptText = textOf(response);
      break;
    }

    const calls = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      const input = call.input as { url?: unknown; purpose?: unknown };
      const url = typeof input.url === "string" ? input.url : "";
      if (url === "" || fetches.length >= fetchBudget) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: url === "" ? "No url given." : "Fetch budget exhausted.",
        });
        continue;
      }
      const outcome = await fetchOnce(
        url,
        typeof input.purpose === "string" ? input.purpose : undefined,
      );
      fetches.push(outcome.record);
      results.push({ type: "tool_result", tool_use_id: call.id, content: outcome.body });
    }
    messages.push({ role: "user", content: results });
  }

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
