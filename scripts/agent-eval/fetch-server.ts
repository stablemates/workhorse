/**
 * The eval's MCP server: one stdio process that offers `fetch_url`, and for a repository session
 * two scoped file tools, and nothing else.
 *
 * `record` starts the `claude` CLI with `--strict-mcp-config`, so this server is the session's
 * only tool source. The server fetches, appends one JSON line per fetch to the log the recorder
 * reads afterwards, and refuses the fetch that would pass the budget. The budget lives here rather
 * than in a turn count because the CLI has no turn limit, and because a fetch is what the budget
 * has always counted.
 *
 * When `AGENT_EVAL_REPOSITORY` names a directory, the server also offers `list_files` and
 * `read_file`, both confined to that directory and logged to `AGENT_EVAL_READ_LOG`. A read is not
 * a fetch: it spends no budget and never enters the fetch log, so the discovery index still reads
 * a position among fetches alone (SM-704).
 *
 * The protocol is small enough to answer directly: `initialize`, `tools/list`, `tools/call`, and
 * the notifications that need no reply.
 */
import { appendFileSync, type Dirent, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { TranscriptFetch, TranscriptRead } from "./transcript.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    process.stderr.write(`fetch-server needs ${name}.\n`);
    process.exit(2);
  }
  return value;
}

const logPath = required("AGENT_EVAL_FETCH_LOG");
const budget = Number(required("AGENT_EVAL_FETCH_BUDGET"));
if (!Number.isInteger(budget) || budget <= 0) {
  process.stderr.write("AGENT_EVAL_FETCH_BUDGET must be a positive whole number.\n");
  process.exit(2);
}

const repositoryEnv = process.env["AGENT_EVAL_REPOSITORY"];
const repositoryRoot =
  repositoryEnv === undefined || repositoryEnv === "" ? undefined : realpathSync(repositoryEnv);
const readLogPath = repositoryRoot === undefined ? undefined : required("AGENT_EVAL_READ_LOG");

interface FetchOutcome {
  readonly record: TranscriptFetch;
  readonly body: string;
}

/** The tool as the session sees it. Frozen: changing it changes what a run measures. */
const fetchToolDescription =
  "Fetch one URL and return its body as text. Returns the status when the fetch is not 2xx.";

const fetchToolSchema = {
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
} as const;

/** The repository tools as the session sees them. Frozen with the repository prompt. */
const listToolDescription =
  "List the entries at one directory inside the application's repository, by path relative to its root. A directory entry ends with a slash.";
const readToolDescription =
  "Read one file inside the application's repository as text, by path relative to its root.";

const pathToolSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "A path relative to the repository root. '.' is the root itself.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

async function fetchOnce(url: string, purpose: string | undefined): Promise<FetchOutcome> {
  try {
    // The eval simulates an agent that accepts Markdown first, so the origin serves the twin on its
    // first fetch and not the HTML it would serve to a browser. This is the Accept header Claude
    // Code sends and the one the site's Accept negotiation is designed for.
    const response = await globalThis.fetch(url, {
      redirect: "follow",
      headers: { Accept: "text/markdown, text/html, */*" },
    });
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

/** The CLI's documented ceiling for one tool result's text. */
export const maxResultSizeChars = 500_000;

let spent = 0;

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function textResult(text: string, isError = false): unknown {
  return { content: [{ type: "text", text }], isError };
}

type Located =
  | { readonly outcome: "ok"; readonly absolute: string }
  | { readonly outcome: "missing" | "refused" };

/**
 * Resolve a session-given path against the repository root and refuse anything that escapes it.
 * The check runs on the real path, so a symlink out of the repository is refused as well.
 */
function locate(root: string, relative: string): Located {
  const absolute = path.resolve(root, relative);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    // A missing path could also be one outside the root; both answers tell the session nothing
    // about the machine, and "missing" is the one that helps it correct a typo.
    return { outcome: "missing" };
  }
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
    return { outcome: "refused" };
  }
  return { outcome: "ok", absolute: real };
}

function logRead(record: TranscriptRead): void {
  appendFileSync(readLogPath!, `${JSON.stringify(record)}\n`);
}

function refusal(tool: TranscriptRead["tool"], relative: string, outcome: "missing" | "refused") {
  logRead({ tool, path: relative, outcome });
  return textResult(
    outcome === "missing"
      ? `${relative} does not exist in the repository.`
      : `${relative} is outside the repository. Only paths inside it can be read.`,
    true,
  );
}

function listFiles(root: string, relative: string): unknown {
  const located = locate(root, relative);
  if (located.outcome !== "ok") return refusal("list_files", relative, located.outcome);
  let entries: Dirent[];
  try {
    entries = readdirSync(located.absolute, { withFileTypes: true });
  } catch {
    logRead({ tool: "list_files", path: relative, outcome: "ok", bytes: 0 });
    return textResult(`${relative} is a file. Use read_file to read it.`, true);
  }
  const listing = entries
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .toSorted()
    .join("\n");
  logRead({ tool: "list_files", path: relative, outcome: "ok", bytes: Buffer.byteLength(listing) });
  return textResult(listing === "" ? "(empty)" : listing);
}

function readFile(root: string, relative: string): unknown {
  const located = locate(root, relative);
  if (located.outcome !== "ok") return refusal("read_file", relative, located.outcome);
  let body: string;
  try {
    body = readFileSync(located.absolute, "utf8");
  } catch {
    logRead({ tool: "read_file", path: relative, outcome: "ok", bytes: 0 });
    return textResult(`${relative} is a directory. Use list_files to list it.`, true);
  }
  logRead({ tool: "read_file", path: relative, outcome: "ok", bytes: Buffer.byteLength(body) });
  return textResult(body);
}

async function handle(message: {
  id?: unknown;
  method?: string;
  params?: {
    name?: string;
    arguments?: { url?: unknown; purpose?: unknown; path?: unknown };
  };
}): Promise<void> {
  // A notification carries no id and takes no reply.
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      reply(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-eval", version: "1.0.0" },
      });
      return;
    case "tools/list":
      reply(message.id, {
        tools: [
          {
            name: "fetch_url",
            description: fetchToolDescription,
            inputSchema: fetchToolSchema,
            // The CLI truncates a large tool result and spills the rest to a file. A documentation
            // page must reach the session whole, so the tool asks for the largest result the CLI
            // allows. 500,000 characters is that ceiling; the landing page is larger still, so
            // `record` also raises MAX_MCP_OUTPUT_TOKENS and the eval note records the cut.
            _meta: { "anthropic/maxResultSizeChars": maxResultSizeChars },
          },
          ...(repositoryRoot === undefined
            ? []
            : [
                {
                  name: "list_files",
                  description: listToolDescription,
                  inputSchema: pathToolSchema,
                },
                {
                  name: "read_file",
                  description: readToolDescription,
                  inputSchema: pathToolSchema,
                  _meta: { "anthropic/maxResultSizeChars": maxResultSizeChars },
                },
              ]),
        ],
      });
      return;
    case "tools/call": {
      const name = message.params?.name;
      const input = message.params?.arguments ?? {};
      if (repositoryRoot !== undefined && (name === "list_files" || name === "read_file")) {
        const relative = typeof input.path === "string" ? input.path : "";
        if (relative === "") {
          reply(message.id, textResult("No path given.", true));
          return;
        }
        reply(
          message.id,
          name === "list_files"
            ? listFiles(repositoryRoot, relative)
            : readFile(repositoryRoot, relative),
        );
        return;
      }
      if (name !== "fetch_url") {
        reply(message.id, textResult(`Unknown tool ${String(name)}.`, true));
        return;
      }
      const url = typeof input.url === "string" ? input.url : "";
      if (url === "") {
        reply(message.id, textResult("No url given.", true));
        return;
      }
      // The session may read the published site and nothing else. The CLI spills a large tool
      // result to a file and names the path, and a session that has lost its documentation to
      // truncation will try to read that path back through this tool. Such a fetch is a harness
      // artifact: it is not a documentation fetch, so it neither spends the budget nor enters the
      // log, where it would shift every later fetch's position and with it the discovery index.
      if (!/^https?:\/\//i.test(url)) {
        reply(
          message.id,
          textResult(
            "fetch_url reads http and https URLs only. Follow a link from a page you have read.",
            true,
          ),
        );
        return;
      }
      if (spent >= budget) {
        reply(message.id, textResult("Fetch budget exhausted.", true));
        return;
      }
      spent += 1;
      const outcome = await fetchOnce(
        url,
        typeof input.purpose === "string" ? input.purpose : undefined,
      );
      appendFileSync(logPath, `${JSON.stringify(outcome.record)}\n`);
      reply(message.id, textResult(outcome.body));
      return;
    }
    default:
      // Every other method is one this server does not implement.
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${String(message.method)}` },
      });
  }
}

// The CLI writes one JSON-RPC message per line. Requests are answered in order, because a fetch
// that overtook another would put the log out of order and the discovery index reads that order.
let queue: Promise<void> = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  let message: Parameters<typeof handle>[0];
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  queue = queue.then(() => handle(message));
});
