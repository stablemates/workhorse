/**
 * How one eval session is launched, kept apart from the recorder so a test can read it.
 *
 * The session must see the published site through `fetch_url` and through nothing else. That is
 * not a preference: a session that reaches a document another way measures Claude Code's harness
 * rather than the documentation, and the fixture stops being evidence. Every option here exists to
 * close one of those routes, so a test asserts the whole set rather than trusting the recorder.
 */
import { fetchBudget } from "./tasks.js";

/** Frozen with the task text. Changing it makes a run incomparable with the recorded fixtures. */
export const systemPrompt = [
  "You are integrating a third-party library into an application you are helping someone build.",
  "You may only read documentation by calling fetch_url. You have no repository checkout, no web",
  "search, and no prior knowledge of this library that you did not read this session.",
  `You may make at most ${fetchBudget} fetches.`,
  "Reach every URL by following a link you have read, except the one you were given to start.",
  "When you are done, output the complete code the application needs, in one message, and then",
  "list every install command the reader must run, one per line, in a fenced block labelled",
  "'install'.",
].join(" ");

/** The one tool the session may call, named as the CLI names a tool from an MCP server. */
export const evalTool = "mcp__agent_eval__fetch_url";

/**
 * The built-in tools that could reach a document some other way. `--allowedTools` already limits
 * the session to the one tool, so this list is the second lock rather than the first.
 */
export const deniedTools = [
  "WebFetch",
  "WebSearch",
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Task",
  "TodoWrite",
];

export interface SessionOptions {
  readonly model: string;
  /** The MCP configuration naming the eval's fetch server, written for this session. */
  readonly mcpConfig: string;
}

/**
 * The CLI arguments for one session.
 *
 * `--system-prompt` replaces the prompt rather than appending to it, and
 * `--exclude-dynamic-system-prompt-sections` drops what the CLI would otherwise inject.
 * `--strict-mcp-config` keeps the maintainer's own MCP servers out, and `--restricted` drops the
 * project and local settings. The recorder runs the session in a scratch directory outside the
 * checkout, which is what keeps `CLAUDE.md` away from it; no flag can do that part.
 */
export function sessionArguments({ model, mcpConfig }: SessionOptions): string[] {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--system-prompt",
    systemPrompt,
    "--exclude-dynamic-system-prompt-sections",
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
    "--restricted",
    "--allowedTools",
    evalTool,
    "--disallowedTools",
    ...deniedTools,
  ];
}

export interface StreamEvent {
  readonly type?: string;
  readonly subtype?: string;
  readonly result?: unknown;
  readonly message?: { readonly content?: readonly { type?: string; text?: string }[] };
}

/** The CLI writes one JSON object per line, and a line it did not finish is not an event. */
export function parseStream(stdout: string): StreamEvent[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as StreamEvent];
      } catch {
        return [];
      }
    });
}

/**
 * The produced program, which is the session's last assistant text. The stream ends with a
 * `result` event carrying it; the last assistant event is the fallback for a session the CLI ended
 * without one.
 */
export function producedText(events: readonly StreamEvent[]): string {
  const final = events.findLast((event) => event.type === "result");
  if (final && typeof final.result === "string" && final.result.trim() !== "") {
    return final.result;
  }
  const assistant = events.findLast((event) => event.type === "assistant");
  return (assistant?.message?.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}
