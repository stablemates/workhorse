import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSignals } from "./mistakes.js";
import { parseTranscript, sessionsRoot } from "./transcript.js";
import { isAgentSurface, scoreRun, scoreSession } from "./score.js";

const baselineRun = path.join(sessionsRoot, "2026-09-01-baseline");
const scratchRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function scratchSession(transcript: unknown, files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "workhorse-agent-eval-"));
  scratchRoots.push(root);
  const directory = path.join(root, "a");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "transcript.json"), JSON.stringify(transcript));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(directory, name), body);
  }
  return directory;
}

function baseTranscript(overrides: Record<string, unknown> = {}) {
  return {
    task: "A",
    language: "typescript",
    run: "scratch",
    recordedAt: "2026-09-02",
    model: "test",
    provenance: "recorded",
    fetches: [],
    install: [],
    mistakes: {
      enqueueOutsideTransaction: "clean",
      schemaOnRuntimePath: "clean",
      effectOutsideCheckpoint: "clean",
    },
    produced: [],
    ...overrides,
  };
}

describe("the committed baseline", () => {
  it("reproduces the discovery index WH-518 recorded for each task", async () => {
    const score = await scoreRun(baselineRun);
    const byTask = Object.fromEntries(
      score.sessions.map((session) => [session.task, session.discoveryIndex]),
    );

    expect(byTask).toEqual({ A: null, B: 10, C: 5, D: 4 });
  });

  it("reproduces the fetch counts, off-site signature fetches, and failed fetches", async () => {
    const score = await scoreRun(baselineRun);
    const rows = score.sessions.map((session) => ({
      task: session.task,
      fetches: session.fetches,
      offSite: session.offSiteSignatureFetches,
      failed: session.failedFetches,
    }));

    expect(rows).toEqual([
      { task: "A", fetches: 15, offSite: 0, failed: 1 },
      { task: "B", fetches: 18, offSite: 1, failed: 1 },
      { task: "C", fetches: 16, offSite: 1, failed: 0 },
      { task: "D", fetches: 18, offSite: 3, failed: 0 },
    ]);
  });

  it("records that three of four sessions produced install commands that resolve", async () => {
    const score = await scoreRun(baselineRun);
    const resolving = score.sessions.filter(
      (session) => session.installsTotal > 0 && session.installsResolved === session.installsTotal,
    );

    expect(resolving.map((session) => session.task)).toEqual(["B", "C", "D"]);
    expect(score.sessions.find((session) => session.task === "A")?.installsResolved).toBe(0);
  });

  it("records the one known mistake the baseline committed", async () => {
    const score = await scoreRun(baselineRun);
    const committed = score.sessions.flatMap((session) =>
      session.mistakes.effectOutsideCheckpoint.recorded === "committed" ? [session.task] : [],
    );

    expect(committed).toEqual(["B"]);
  });

  it("keeps every fixture free of response bodies and honest about its provenance", async () => {
    const score = await scoreRun(baselineRun);

    for (const session of score.sessions) {
      expect(session.provenance).toBe("reconstructed");
      expect(session.programRead).toBe(false);
    }
    expect(score.contradictions).toEqual([]);
  });
});

describe("discovery", () => {
  it("counts the router, the corpus, the agent page, and any Markdown twin", () => {
    for (const url of [
      "https://workhorse.run/llms.txt",
      "https://workhorse.run/llms-full.txt",
      "https://workhorse.run/docs/for-ai-agents",
      "https://workhorse.run/docs/enqueue.md",
    ]) {
      expect(isAgentSurface({ url, status: 200 })).toBe(true);
    }
  });

  it("does not count an HTML docs page, another host, or a failed fetch", () => {
    expect(isAgentSurface({ url: "https://workhorse.run/docs/enqueue", status: 200 })).toBe(false);
    expect(isAgentSurface({ url: "https://pkg.go.dev/x.md", status: 200 })).toBe(false);
    expect(isAgentSurface({ url: "https://workhorse.run/llms.txt", status: 404 })).toBe(false);
  });
});

describe("mistake signals", () => {
  it("reads a checkpoint out of a produced TypeScript program", () => {
    const signals = readSignals(
      'worker.handle("send", async (payload, context) => { await context.checkpoint("send", send); });',
      "typescript",
    );

    expect(signals.effectOutsideCheckpoint.verdict).toBe("clean");
  });

  it("calls a handler with no checkpoint a committed mistake", () => {
    const signals = readSignals(
      'worker.handle("send", async (payload) => { await sendEmail(payload); });',
      "typescript",
    );

    expect(signals.effectOutsideCheckpoint.verdict).toBe("committed");
  });

  it("catches a TypeScript enqueue that names no transaction", () => {
    const signals = readSignals('await queue.enqueue("send", { id }, {});', "typescript");

    expect(signals.enqueueOutsideTransaction.verdict).toBe("committed");
  });

  it("accepts a TypeScript enqueue that passes the transaction, nested calls and all", () => {
    const signals = readSignals(
      'await queue.enqueue("send", buildPayload(order, { retries: 1 }), {}, tx);',
      "typescript",
    );

    expect(signals.enqueueOutsideTransaction.verdict).toBe("clean");
  });

  it("catches an application that installs the schema itself", () => {
    const signals = readSignals("await installSchema(pool);", "typescript");

    expect(signals.schemaOnRuntimePath.verdict).toBe("committed");
  });
});

describe("scoring a session with a produced program", () => {
  it("fails the run when the program contradicts the recorded read", async () => {
    const directory = await scratchSession(
      baseTranscript({
        mistakes: {
          enqueueOutsideTransaction: "clean",
          schemaOnRuntimePath: "clean",
          effectOutsideCheckpoint: "clean",
        },
        produced: ["app.ts"],
      }),
      { "app.ts": 'worker.handle("send", async (p) => { await sendEmail(p); });' },
    );

    const score = await scoreSession(directory);

    expect(score.programRead).toBe(true);
    expect(score.mistakes.effectOutsideCheckpoint.contradicted).toBe(true);
  });

  it("never contradicts a recorded read on an unclear signal", async () => {
    const directory = await scratchSession(baseTranscript({ produced: ["app.ts"] }), {
      "app.ts": "// nothing to read",
    });

    const score = await scoreSession(directory);

    for (const mistake of Object.values(score.mistakes)) {
      expect(mistake.contradicted).toBe(false);
    }
  });
});

describe("the fixture schema", () => {
  it("rejects a reconstructed fixture that does not say where it came from", () => {
    expect(() =>
      parseTranscript(baseTranscript({ provenance: "reconstructed" }), "fixture"),
    ).toThrow(/where it came from/);
  });

  it("rejects an unknown task", () => {
    expect(() => parseTranscript(baseTranscript({ task: "E" }), "fixture")).toThrow(/task/);
  });
});
