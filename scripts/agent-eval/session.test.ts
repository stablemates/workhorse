import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repositoryFiles, repositoryPackage } from "./repository.js";
import {
  deniedTools,
  evalTool,
  parseStream,
  producedText,
  repositoryTools,
  sessionArguments,
} from "./session.js";
import { fetchBudget, taskById } from "./tasks.js";
import type { TranscriptFetch, TranscriptRead } from "./transcript.js";

const scratchRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function argumentsFor(): string[] {
  return sessionArguments({ model: "claude-opus-5", mcpConfig: "/tmp/mcp.json" });
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("sessionArguments", () => {
  it("replaces the system prompt rather than appending to it", () => {
    const args = argumentsFor();
    expect(args).toContain("--system-prompt");
    expect(args).not.toContain("--append-system-prompt");
    expect(valueAfter(args, "--system-prompt")).toContain("You may only read documentation");
    expect(valueAfter(args, "--system-prompt")).toContain(`at most ${fetchBudget} fetches`);
  });

  // Whatever the CLI would otherwise inject is documentation the published site did not give the
  // session, so a run with it measures something else.
  it("excludes the dynamic system prompt sections", () => {
    expect(argumentsFor()).toContain("--exclude-dynamic-system-prompt-sections");
  });

  // These two are what keep this repository out of the session: `--restricted` drops the project
  // and local settings, and `--strict-mcp-config` drops the maintainer's own MCP servers.
  it("drops the repository's settings and every MCP server but the eval's", () => {
    const args = argumentsFor();
    expect(args).toContain("--restricted");
    expect(args).toContain("--strict-mcp-config");
    expect(valueAfter(args, "--mcp-config")).toBe("/tmp/mcp.json");
  });

  it("allows the eval's fetch tool and nothing else", () => {
    const args = argumentsFor();
    expect(valueAfter(args, "--allowedTools")).toBe(evalTool);
  });

  it("denies every built-in tool that could reach a document another way", () => {
    const args = argumentsFor();
    for (const tool of ["WebFetch", "WebSearch", "Bash", "Read", "Glob", "Grep"]) {
      expect(deniedTools).toContain(tool);
      expect(args).toContain(tool);
    }
  });

  // Task E (SM-704) starts inside a repository. The session may read it, through the eval's own
  // scoped tools and never the CLI's, and its prompt says it was given no URL. A URL-start session
  // keeps the frozen prompt and the one tool.
  it("adds the two repository tools and the repository prompt only for a repository session", () => {
    const withRepository = sessionArguments({
      model: "claude-opus-5",
      mcpConfig: "/tmp/mcp.json",
      repository: "/tmp/orders-app",
    });
    expect(valueAfter(withRepository, "--allowedTools")).toBe(
      [evalTool, ...repositoryTools].join(","),
    );
    expect(valueAfter(withRepository, "--system-prompt")).toContain(
      "You were given no documentation URL",
    );
    expect(valueAfter(withRepository, "--system-prompt")).toContain(
      `at most ${fetchBudget} fetches`,
    );
    for (const tool of ["Read", "Glob", "Grep", "Bash"]) {
      expect(withRepository).toContain(tool);
    }

    const withoutRepository = argumentsFor();
    expect(valueAfter(withoutRepository, "--allowedTools")).toBe(evalTool);
    expect(valueAfter(withoutRepository, "--system-prompt")).toContain("no repository checkout");
  });

  it("asks for the stream the recorder parses", () => {
    const args = argumentsFor();
    expect(args).toContain("--print");
    expect(valueAfter(args, "--output-format")).toBe("stream-json");
  });
});

describe("producedText", () => {
  it("takes the result event, which carries the session's last message", () => {
    expect(producedText(parseStream('{"type":"result","result":"the program"}'))).toBe(
      "the program",
    );
  });

  it("falls back to the last assistant text when the CLI ended without a result", () => {
    const stream = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"first"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"last"}]}}',
    ].join("\n");
    expect(producedText(parseStream(stream))).toBe("last");
  });

  it("ignores a line the CLI did not finish writing", () => {
    expect(parseStream('{"type":"result","result":"kept"}\n{"type":"resu')).toHaveLength(1);
  });
});

/**
 * A stand-in for the published site. The server tests assert what the harness records about a
 * fetch, so the fetch has to be one whose status, content type and body this test decides. Reaching
 * the real site would make a unit test depend on the network and on what the site serves today.
 */
function startSite(): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((request, response) => {
      if (request.url === "/missing") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("gone");
        return;
      }
      response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      response.end(`# page ${request.url}`);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

interface ServerCall {
  readonly name: "fetch_url" | "list_files" | "read_file";
  readonly arguments: Record<string, string>;
}

interface ServerRun {
  readonly replies: { text: string; isError: boolean }[];
  readonly logged: TranscriptFetch[];
  readonly reads: TranscriptRead[];
  readonly tools: string[];
}

async function readJsonLines<T>(file: string): Promise<T[]> {
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/** Drives the MCP server the way the CLI does: one JSON-RPC message per line on stdin. */
async function driveServer(
  budget: number,
  calls: readonly ServerCall[],
  repository?: string,
): Promise<ServerRun> {
  const root = await mkdtemp(path.join(tmpdir(), "workhorse-fetch-server-"));
  scratchRoots.push(root);
  const log = path.join(root, "fetches.jsonl");
  const readLog = path.join(root, "reads.jsonl");
  await writeFile(log, "");
  await writeFile(readLog, "");

  const server = path.join(import.meta.dirname, "fetch-server.ts");
  const tsx = path.resolve(import.meta.dirname, "../../node_modules/.bin/tsx");
  const child = spawn(tsx, [server], {
    env: {
      ...process.env,
      AGENT_EVAL_FETCH_LOG: log,
      AGENT_EVAL_FETCH_BUDGET: String(budget),
      ...(repository === undefined
        ? {}
        : { AGENT_EVAL_REPOSITORY: repository, AGENT_EVAL_READ_LOG: readLog }),
    },
  });

  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: -1, method: "tools/list" })}\n`);
  calls.forEach((call, index) => {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: index + 1,
        method: "tools/call",
        params: { name: call.name, arguments: call.arguments },
      })}\n`,
    );
  });
  child.stdin.end();
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });

  const messages = stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(
      (line) =>
        JSON.parse(line) as {
          id: number;
          result?: {
            content?: [{ text: string }];
            isError?: boolean;
            tools?: { name: string }[];
          };
        },
    );
  const replies = messages
    .filter((message) => message.id > 0)
    .map((message) => ({
      text: message.result?.content?.[0]?.text ?? "",
      isError: message.result?.isError === true,
    }));
  const tools = (messages.find((message) => message.id === -1)?.result?.tools ?? []).map(
    (tool) => tool.name,
  );

  return {
    replies,
    logged: await readJsonLines<TranscriptFetch>(log),
    reads: await readJsonLines<TranscriptRead>(readLog),
    tools,
  };
}

function callServer(
  budget: number,
  calls: readonly { url: string }[],
): Promise<{ replies: ServerRun["replies"]; logged: TranscriptFetch[] }> {
  return driveServer(
    budget,
    calls.map((call) => ({ name: "fetch_url", arguments: { url: call.url } })),
  );
}

/** A scratch repository with the shape `repository.ts` writes, minus the install. */
async function scratchRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "workhorse-eval-repository-"));
  scratchRoots.push(root);
  for (const [name, body] of Object.entries(repositoryFiles)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), body);
  }
  await mkdir(path.join(root, "node_modules", "@stablemates", "workhorse"), { recursive: true });
  await writeFile(
    path.join(root, "node_modules", "@stablemates", "workhorse", "README.md"),
    "# @stablemates/workhorse\n\n[For AI agents](https://workhorse.run/llms.txt)\n",
  );
  return root;
}

describe("the fetch server", () => {
  // The CLI truncates a large tool result, spills the rest to a file, and names the path. A
  // session that lost its documentation that way will try to read the path back through this tool.
  // Counting that as a fetch shifts every later fetch's position, and the discovery index is a
  // position.
  it("refuses a URL that is not http, and neither logs it nor spends the budget", async () => {
    const site = await startSite();
    try {
      const { replies, logged } = await callServer(2, [
        { url: "file:///etc/hostname" },
        { url: `${site.origin}/llms.txt` },
        { url: `${site.origin}/robots.txt` },
      ]);

      expect(replies[0]?.isError).toBe(true);
      expect(replies[0]?.text).toContain("http and https URLs only");
      expect(replies[1]?.isError).toBe(false);
      expect(replies[2]?.isError).toBe(false);
      expect(logged.map((fetched) => fetched.url)).toEqual([
        `${site.origin}/llms.txt`,
        `${site.origin}/robots.txt`,
      ]);
    } finally {
      await site.close();
    }
  }, 30_000);

  it("refuses the fetch past the budget and records the ones within it", async () => {
    const site = await startSite();
    try {
      const { replies, logged } = await callServer(1, [
        { url: `${site.origin}/llms.txt` },
        { url: `${site.origin}/robots.txt` },
      ]);

      expect(replies[0]?.isError).toBe(false);
      expect(replies[1]?.isError).toBe(true);
      expect(replies[1]?.text).toBe("Fetch budget exhausted.");
      expect(logged.map((fetched) => fetched.url)).toEqual([`${site.origin}/llms.txt`]);
    } finally {
      await site.close();
    }
  }, 30_000);

  // Three scored dimensions read these fields, and they are real only because the harness fetches.
  it("records the status, content type and byte count of each fetch", async () => {
    const site = await startSite();
    try {
      const { logged } = await callServer(3, [
        { url: `${site.origin}/docs.md` },
        { url: `${site.origin}/missing` },
      ]);

      expect(logged[0]).toMatchObject({
        url: `${site.origin}/docs.md`,
        status: 200,
        contentType: "text/markdown; charset=utf-8",
        bytes: Buffer.byteLength("# page /docs.md"),
      });
      expect(logged[1]).toMatchObject({ status: 404 });
    } finally {
      await site.close();
    }
  }, 30_000);
});

describe("the repository tools", () => {
  it("are offered only when a repository is named", async () => {
    const withoutRepository = await driveServer(1, []);
    expect(withoutRepository.tools).toEqual(["fetch_url"]);

    const withRepository = await driveServer(1, [], await scratchRepository());
    expect(withRepository.tools).toEqual(["fetch_url", "list_files", "read_file"]);
  }, 30_000);

  // A read is not a fetch. It spends no budget and never enters the fetch log, so the discovery
  // index still reads a position among fetches alone.
  it("read the repository, log apart from fetches, and spend no fetch budget", async () => {
    const repository = await scratchRepository();
    const { replies, logged, reads } = await driveServer(
      1,
      [
        { name: "list_files", arguments: { path: "." } },
        { name: "read_file", arguments: { path: "package.json" } },
        { name: "read_file", arguments: { path: "node_modules/@stablemates/workhorse/README.md" } },
      ],
      repository,
    );

    expect(replies[0]?.isError).toBe(false);
    expect(replies[0]?.text.split("\n")).toContain("src/");
    expect(replies[1]?.text).toContain(repositoryPackage);
    expect(replies[2]?.text).toContain("https://workhorse.run/llms.txt");
    expect(logged).toEqual([]);
    expect(reads.map((read) => [read.tool, read.path, read.outcome])).toEqual([
      ["list_files", ".", "ok"],
      ["read_file", "package.json", "ok"],
      ["read_file", "node_modules/@stablemates/workhorse/README.md", "ok"],
    ]);
  }, 30_000);

  it("refuse a path outside the repository and record the refusal", async () => {
    const repository = await scratchRepository();
    const { replies, reads } = await driveServer(
      1,
      [
        { name: "read_file", arguments: { path: "../../etc/hostname" } },
        { name: "read_file", arguments: { path: "/etc/hostname" } },
        { name: "read_file", arguments: { path: "src/missing.ts" } },
      ],
      repository,
    );

    expect(replies[0]?.isError).toBe(true);
    expect(replies[0]?.text).toContain("outside the repository");
    expect(replies[1]?.isError).toBe(true);
    expect(replies[2]?.isError).toBe(true);
    expect(replies[2]?.text).toContain("does not exist");
    expect(reads.map((read) => read.outcome)).toEqual(["refused", "refused", "missing"]);
  }, 30_000);
});

describe("the task E repository", () => {
  it("depends on the SDK, inserts the order row, and points nowhere", () => {
    expect(taskById("E").startUrl).toBeNull();
    const manifest = JSON.parse(repositoryFiles["package.json"]!) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies)).toContain(repositoryPackage);
    expect(repositoryFiles["src/orders.ts"]).toContain("INSERT INTO orders");
    expect(repositoryFiles["README.md"]).not.toMatch(/workhorse\.run|llms\.txt|http/);
  });
});
