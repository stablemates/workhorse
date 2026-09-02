/**
 * Score recorded agent documentation sessions.
 *
 * Usage: pnpm agent-eval:score [run-directory] [--registries] [--json]
 *
 * Scoring is mechanical and offline. It needs no model key, no network, and nothing beyond the
 * committed fixture, so anyone can re-run it for free and its numbers cannot drift. Install
 * resolution is reported from what each fixture recorded; `--registries` re-asks the real
 * registries, which is the one thing here that needs the network.
 *
 * This never runs in CI. A frozen fixture's score never changes, so a green check that cannot go
 * red is noise, and recording is barred from CI by ADR 0043.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { contradicts, readSignals, type SignalVerdict } from "./mistakes.js";
import { documentationHost, type Language, type TaskId } from "./tasks.js";
import {
  type MistakeName,
  mistakeNames,
  type MistakeVerdict,
  readTranscript,
  sessionsRoot,
  type Transcript,
  type TranscriptFetch,
  type TranscriptInstall,
} from "./transcript.js";

/** With no run named, score the newest one, which is the run a maintainer just wrote. */
async function newestRun(): Promise<string> {
  const entries = await readdir(sessionsRoot, { withFileTypes: true });
  const runs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  const newest = runs.at(-1);
  if (newest === undefined) {
    throw new Error(`No runs under ${sessionsRoot}.`);
  }
  return path.join(sessionsRoot, newest);
}

/** A fetch that returned an agent surface: the router, the whole corpus, or a Markdown twin. */
export function isAgentSurface(fetch: TranscriptFetch): boolean {
  let url: URL;
  try {
    url = new URL(fetch.url);
  } catch {
    return false;
  }
  if (url.host !== documentationHost) {
    return false;
  }
  if (fetch.status !== null && (fetch.status < 200 || fetch.status > 299)) {
    return false;
  }
  const { pathname } = url;
  return (
    pathname === "/llms.txt" ||
    pathname === "/llms-full.txt" ||
    pathname === "/docs/for-ai-agents" ||
    (pathname.startsWith("/docs/") && pathname.endsWith(".md"))
  );
}

function isOffSite(fetch: TranscriptFetch): boolean {
  try {
    return new URL(fetch.url).host !== documentationHost;
  } catch {
    return true;
  }
}

export interface MistakeScore {
  readonly recorded: MistakeVerdict;
  readonly signal: SignalVerdict;
  readonly reason: string;
  readonly contradicted: boolean;
}

export interface SessionScore {
  readonly task: TaskId;
  readonly language: Language;
  readonly provenance: Transcript["provenance"];
  readonly fetches: number;
  /** 1-based index of the first fetch returning an agent surface, or null when it never happens. */
  readonly discoveryIndex: number | null;
  readonly offSiteSignatureFetches: number;
  readonly failedFetches: number;
  readonly installsResolved: number;
  readonly installsTotal: number;
  readonly installsUnchecked: number;
  readonly mistakes: Readonly<Record<MistakeName, MistakeScore>>;
  /** Whether a produced program was available to read signals from. */
  readonly programRead: boolean;
}

export interface RunScore {
  readonly run: string;
  readonly sessions: readonly SessionScore[];
  readonly contradictions: readonly string[];
}

async function readProducedSource(directory: string, produced: readonly string[]): Promise<string> {
  const bodies = await Promise.all(
    produced.map(async (name) => {
      try {
        return await readFile(path.join(directory, name), "utf8");
      } catch {
        return "";
      }
    }),
  );
  return bodies.join("\n");
}

export async function scoreSession(directory: string): Promise<SessionScore> {
  const transcript = await readTranscript(directory);
  const discoveryPosition = transcript.fetches.findIndex(isAgentSurface);
  const source = await readProducedSource(directory, transcript.produced);
  const programRead = source.trim().length > 0;
  const signals = programRead ? readSignals(source, transcript.language) : undefined;

  const mistakes = Object.fromEntries(
    mistakeNames.map((name) => {
      const recorded = transcript.mistakes[name];
      const signal = signals?.[name];
      return [
        name,
        {
          recorded,
          signal: signal?.verdict ?? "unclear",
          reason: signal?.reason ?? "no produced program committed",
          contradicted: signal !== undefined && contradicts(signal, recorded),
        } satisfies MistakeScore,
      ] as const;
    }),
  ) as Readonly<Record<MistakeName, MistakeScore>>;

  return {
    task: transcript.task,
    language: transcript.language,
    provenance: transcript.provenance,
    fetches: transcript.fetches.length,
    discoveryIndex: discoveryPosition === -1 ? null : discoveryPosition + 1,
    offSiteSignatureFetches: transcript.fetches.filter(
      (fetch) => fetch.purpose === "signature" && isOffSite(fetch),
    ).length,
    failedFetches: transcript.fetches.filter(
      (fetch) => fetch.status !== null && (fetch.status < 200 || fetch.status > 299),
    ).length,
    installsResolved: transcript.install.filter((install) => install.resolved === true).length,
    installsTotal: transcript.install.length,
    installsUnchecked: transcript.install.filter((install) => install.resolved === null).length,
    mistakes,
    programRead,
  };
}

function escapeGoModule(module: string): string {
  return module.replaceAll(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
}

function registryUrl(install: TranscriptInstall): string {
  const { registry, package: name, version } = install;
  if (registry === "npm") {
    const encoded = name.replace("/", "%2F");
    return version === null
      ? `https://registry.npmjs.org/${encoded}`
      : `https://registry.npmjs.org/${encoded}/${version}`;
  }
  if (registry === "pypi") {
    return version === null
      ? `https://pypi.org/pypi/${name}/json`
      : `https://pypi.org/pypi/${name}/${version}/json`;
  }
  const module = escapeGoModule(name);
  return version === null
    ? `https://proxy.golang.org/${module}/@latest`
    : `https://proxy.golang.org/${module}/@v/${version}.info`;
}

/** Ask each registry whether the command a session produced still resolves. Needs the network. */
export async function checkRegistries(
  install: readonly TranscriptInstall[],
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  for (const entry of install) {
    const url = registryUrl(entry);
    try {
      const response = await globalThis.fetch(url, { method: "GET" });
      results.set(entry.command, response.ok);
    } catch {
      results.set(entry.command, false);
    }
  }
  return results;
}

async function sessionDirectories(runDirectory: string): Promise<string[]> {
  const entries = await readdir(runDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runDirectory, entry.name))
    .toSorted();
}

function formatMistake(name: MistakeName, score: MistakeScore): string {
  const signal =
    score.signal === "unclear" ? `signal unclear (${score.reason})` : `signal ${score.signal}`;
  const flag = score.contradicted ? "  ** contradicts the recorded read **" : "";
  return `    ${name}: recorded ${score.recorded}, ${signal}${flag}`;
}

function report(score: RunScore): string {
  const lines: string[] = [`Agent documentation eval — run ${score.run}`, ""];
  for (const session of score.sessions) {
    lines.push(
      `  Task ${session.task} (${session.language}, ${session.provenance}) — ${session.fetches} fetches`,
      `    discovery index: ${session.discoveryIndex ?? "never"}`,
      `    off-site signature fetches: ${session.offSiteSignatureFetches}`,
      `    failed fetches: ${session.failedFetches}`,
      `    install commands resolving: ${session.installsResolved} of ${session.installsTotal}` +
        (session.installsUnchecked > 0 ? ` (${session.installsUnchecked} never checked)` : ""),
    );
    for (const name of mistakeNames) {
      lines.push(formatMistake(name, session.mistakes[name]));
    }
    lines.push("");
  }
  const arrived = score.sessions.filter((session) => session.discoveryIndex !== null);
  const resolving = score.sessions.filter(
    (session) => session.installsTotal > 0 && session.installsResolved === session.installsTotal,
  );
  const committed = score.sessions.filter((session) =>
    mistakeNames.some((name) => session.mistakes[name].recorded === "committed"),
  );
  lines.push(
    "  Summary",
    `    sessions reaching an agent surface: ${arrived.length} of ${score.sessions.length}`,
    `    sessions whose install commands all resolve: ${resolving.length} of ${score.sessions.length}`,
    `    sessions committing a known mistake: ${committed.length} of ${score.sessions.length}`,
    "",
  );
  if (score.contradictions.length > 0) {
    lines.push("  Contradictions between a recorded read and a produced program:");
    lines.push(...score.contradictions.map((line) => `    - ${line}`), "");
  }
  return lines.join("\n");
}

export async function scoreRun(runDirectory: string): Promise<RunScore> {
  const directories = await sessionDirectories(runDirectory);
  if (directories.length === 0) {
    throw new Error(`No session directories under ${runDirectory}.`);
  }
  const sessions = await Promise.all(directories.map(scoreSession));
  const contradictions = sessions.flatMap((session) =>
    mistakeNames
      .filter((name) => session.mistakes[name].contradicted)
      .map(
        (name) =>
          `task ${session.task}: ${name} recorded ${session.mistakes[name].recorded}, program says ${session.mistakes[name].signal}`,
      ),
  );
  return { run: path.basename(runDirectory), sessions, contradictions };
}

if (import.meta.filename === process.argv[1]) {
  const named = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
  const flags = new Set(process.argv.slice(2).filter((argument) => argument.startsWith("--")));
  const runDirectory = named === undefined ? await newestRun() : path.resolve(named);
  const score = await scoreRun(runDirectory);

  if (flags.has("--registries")) {
    for (const directory of await sessionDirectories(runDirectory)) {
      const transcript = await readTranscript(directory);
      const live = await checkRegistries(transcript.install);
      for (const [command, ok] of live) {
        process.stdout.write(`  ${ok ? "resolves" : "does not resolve"}: ${command}\n`);
      }
    }
  }

  process.stdout.write(flags.has("--json") ? `${JSON.stringify(score, null, 2)}\n` : report(score));
  if (score.contradictions.length > 0) {
    process.exitCode = 1;
  }
}
