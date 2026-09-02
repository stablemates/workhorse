/**
 * The recorded session fixture that `record` writes and `score` reads.
 *
 * A transcript stores what a session fetched and what it produced, never a response body. A body is
 * the site at one commit: storing it would bloat the fixture and go stale, and no scored dimension
 * needs it.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Language, type TaskId, taskIds } from "./tasks.js";

/** How a fixture came to exist. Provenance changes what a score may claim, so it is required. */
export type Provenance = "recorded" | "reconstructed";

export interface TranscriptFetch {
  readonly url: string;
  /** HTTP status, or null when the source record does not state one. */
  readonly status: number | null;
  /** Set when the session made this fetch to learn an SDK name. */
  readonly purpose?: "signature";
  readonly contentType?: string;
  readonly bytes?: number;
  /** Anything the status cannot carry, such as a 200 whose language tabs were absent. */
  readonly note?: string;
}

export type Registry = "npm" | "pypi" | "goproxy";

export interface TranscriptInstall {
  /** The command as the session wrote it. */
  readonly command: string;
  readonly registry: Registry;
  readonly package: string;
  /** null when the command names no version. */
  readonly version: string | null;
  /** What the registry said when this fixture was written. null when it was never asked. */
  readonly resolved: boolean | null;
}

/** A maintainer's read of one known mistake, recorded with the fixture. */
export type MistakeVerdict = "clean" | "committed";

export const mistakeNames = [
  "enqueueOutsideTransaction",
  "schemaOnRuntimePath",
  "effectOutsideCheckpoint",
] as const;

export type MistakeName = (typeof mistakeNames)[number];

export type TranscriptMistakes = Readonly<Record<MistakeName, MistakeVerdict>>;

export interface Transcript {
  readonly task: TaskId;
  readonly language: Language;
  /** The run this session belongs to, which is how a before is compared with an after. */
  readonly run: string;
  readonly recordedAt: string;
  readonly model: string;
  readonly provenance: Provenance;
  /** Where a reconstructed fixture came from. Required when provenance is not "recorded". */
  readonly source?: string;
  readonly fetches: readonly TranscriptFetch[];
  readonly install: readonly TranscriptInstall[];
  /** The maintainer's read, which the score reports and a produced program can contradict. */
  readonly mistakes: TranscriptMistakes;
  /** File names beside the transcript, or empty when the produced program was not kept. */
  readonly produced: readonly string[];
}

export const transcriptFileName = "transcript.json";

/** Runs live under here, one directory per run, each holding one directory per session. */
export const sessionsRoot = path.join(
  path.resolve(import.meta.dirname, "../.."),
  "scripts/agent-eval/sessions",
);

const registries = new Set<Registry>(["npm", "pypi", "goproxy"]);
const languages = new Set<Language>(["typescript", "python", "go"]);
const verdicts = new Set<MistakeVerdict>(["clean", "committed"]);

function fail(location: string, message: string): never {
  throw new Error(`${location}: ${message}`);
}

function asRecord(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(location, "expected an object");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(location, "expected a non-empty string");
  }
  return value;
}

function asNullableNumber(value: unknown, location: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(location, "expected a number or null");
  }
  return value;
}

function asArray(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(location, "expected an array");
  }
  return value;
}

function parseFetch(value: unknown, location: string): TranscriptFetch {
  const raw = asRecord(value, location);
  const purpose = raw["purpose"];
  if (purpose !== undefined && purpose !== "signature") {
    fail(`${location}.purpose`, 'expected "signature" or nothing');
  }
  return {
    url: asString(raw["url"], `${location}.url`),
    status: asNullableNumber(raw["status"], `${location}.status`),
    ...(purpose === "signature" ? { purpose } : {}),
    ...(raw["contentType"] === undefined
      ? {}
      : { contentType: asString(raw["contentType"], `${location}.contentType`) }),
    ...(raw["bytes"] === undefined
      ? {}
      : { bytes: asNullableNumber(raw["bytes"], `${location}.bytes`) ?? 0 }),
    ...(raw["note"] === undefined ? {} : { note: asString(raw["note"], `${location}.note`) }),
  };
}

function parseInstall(value: unknown, location: string): TranscriptInstall {
  const raw = asRecord(value, location);
  const registry = asString(raw["registry"], `${location}.registry`);
  if (!registries.has(registry as Registry)) {
    fail(`${location}.registry`, `expected one of ${[...registries].join(", ")}`);
  }
  const version = raw["version"];
  if (version !== null && typeof version !== "string") {
    fail(`${location}.version`, "expected a string or null");
  }
  const resolved = raw["resolved"];
  if (resolved !== null && typeof resolved !== "boolean") {
    fail(`${location}.resolved`, "expected a boolean or null");
  }
  return {
    command: asString(raw["command"], `${location}.command`),
    registry: registry as Registry,
    package: asString(raw["package"], `${location}.package`),
    version: version as string | null,
    resolved: resolved as boolean | null,
  };
}

function parseMistakes(value: unknown, location: string): TranscriptMistakes {
  const raw = asRecord(value, location);
  const entries = mistakeNames.map((name) => {
    const verdict = asString(raw[name], `${location}.${name}`);
    if (!verdicts.has(verdict as MistakeVerdict)) {
      fail(`${location}.${name}`, `expected one of ${[...verdicts].join(", ")}`);
    }
    return [name, verdict as MistakeVerdict] as const;
  });
  return Object.fromEntries(entries) as TranscriptMistakes;
}

export function parseTranscript(value: unknown, location: string): Transcript {
  const raw = asRecord(value, location);
  const task = asString(raw["task"], `${location}.task`);
  if (!taskIds.includes(task as TaskId)) {
    fail(`${location}.task`, `expected one of ${taskIds.join(", ")}`);
  }
  const language = asString(raw["language"], `${location}.language`);
  if (!languages.has(language as Language)) {
    fail(`${location}.language`, `expected one of ${[...languages].join(", ")}`);
  }
  const provenance = asString(raw["provenance"], `${location}.provenance`);
  if (provenance !== "recorded" && provenance !== "reconstructed") {
    fail(`${location}.provenance`, 'expected "recorded" or "reconstructed"');
  }
  if (provenance === "reconstructed" && raw["source"] === undefined) {
    fail(`${location}.source`, "a reconstructed fixture must name where it came from");
  }
  return {
    task: task as TaskId,
    language: language as Language,
    run: asString(raw["run"], `${location}.run`),
    recordedAt: asString(raw["recordedAt"], `${location}.recordedAt`),
    model: asString(raw["model"], `${location}.model`),
    provenance,
    ...(raw["source"] === undefined
      ? {}
      : { source: asString(raw["source"], `${location}.source`) }),
    fetches: asArray(raw["fetches"], `${location}.fetches`).map((entry, index) =>
      parseFetch(entry, `${location}.fetches[${index}]`),
    ),
    install: asArray(raw["install"], `${location}.install`).map((entry, index) =>
      parseInstall(entry, `${location}.install[${index}]`),
    ),
    mistakes: parseMistakes(raw["mistakes"], `${location}.mistakes`),
    produced: asArray(raw["produced"], `${location}.produced`).map((entry, index) =>
      asString(entry, `${location}.produced[${index}]`),
    ),
  };
}

/** Read and validate one session directory's transcript. */
export async function readTranscript(sessionDirectory: string): Promise<Transcript> {
  const file = path.join(sessionDirectory, transcriptFileName);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new Error(`No ${transcriptFileName} in ${sessionDirectory}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
  return parseTranscript(parsed, file);
}

/** Serialise a transcript the way every committed fixture is written. */
export function formatTranscript(transcript: Transcript): string {
  return `${JSON.stringify(transcript, null, 2)}\n`;
}
