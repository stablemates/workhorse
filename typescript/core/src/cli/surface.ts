import type {
  CancelResult,
  DeadLetterPage,
  JobCheckpoint,
  JobListPage,
  JobSnapshot,
  JobTimelinePage,
  JobWait,
  QueueHealth,
  RedriveResult,
  WorkerPauseResult,
  WorkerRegistryEntry,
} from "../types.js";
import type { StoredSchedule } from "../queue/cron-schedules.js";
import type {
  AdminExternalWaits,
  AdminMaintenanceState,
  AdminQueueStatus,
} from "./admin-client.js";
import type { SchemaStatusReport } from "./schema-status.js";

/**
 * What the `workhorse` CLI accepts, declared once.
 *
 * ADR 0054 governs the command set, the flag set, the meaning of each exit code, and the fields of
 * every `--json` payload. Nothing in the CLI's own text is governed, because a script reads
 * `--json` and a person reads the prose.
 *
 * The declaration is here rather than in `api/cli.txt` because the CLI consumes it. Dispatch tests
 * each name against {@link CLI_COMMANDS} and {@link ADMIN_COMMANDS}, every `parseCommandArgs` call
 * takes its options from {@link CLI_OPTIONS}, and every `--json` writer states its payload as
 * {@link CliJsonPayloads}, so the compiler rejects a payload that is not the declared type. A
 * declaration the CLI did not consult would let a rename land in the parser and leave the snapshot
 * unchanged, and a snapshot that cannot notice a rename is not a check.
 *
 * `scripts/cli-surface.ts` reads this module and writes `api/cli.txt`.
 */

/** Every option one command accepts, in the shape `node:util`'s `parseArgs` takes. */
const DATABASE_OPTIONS = {
  "database-url": { type: "string" },
} as const;

const HELP_OPTION = {
  help: { type: "boolean", short: "h" },
} as const;

export const CLI_OPTIONS = {
  /** `workhorse` with no command, and the two flags that stand alone. */
  workhorse: { ...HELP_OPTION, version: { type: "boolean" } },
  init: { dir: { type: "string" }, force: { type: "boolean" }, ...HELP_OPTION },
  /** `workhorse schema` with no action prints the group's help and takes nothing else. */
  schema: HELP_OPTION,
  "schema install": { ...DATABASE_OPTIONS, ...HELP_OPTION },
  "schema migrate": { ...DATABASE_OPTIONS, ...HELP_OPTION },
  "schema status": { ...DATABASE_OPTIONS, json: { type: "boolean" }, ...HELP_OPTION },
  worker: {
    config: { type: "string" },
    "shutdown-timeout-ms": { type: "string" },
    ...HELP_OPTION,
  },
  dashboard: {
    ...DATABASE_OPTIONS,
    port: { type: "string" },
    host: { type: "string" },
    socket: { type: "string" },
    "public-origin": { type: "string" },
    "allow-mutations": { type: "boolean" },
    actor: { type: "string" },
    workspace: { type: "string", multiple: true },
    config: { type: "string" },
    ...HELP_OPTION,
  },
  /**
   * One option set for every `admin` subcommand.
   *
   * `admin` parses once, before it knows which subcommand ran, so a flag only some subcommands use
   * is still accepted by all of them. The snapshot says so rather than implying eighteen sets.
   */
  admin: {
    ...DATABASE_OPTIONS,
    json: { type: "boolean" },
    queue: { type: "string" },
    type: { type: "string" },
    state: { type: "string", multiple: true },
    limit: { type: "string" },
    namespace: { type: "string", multiple: true },
    name: { type: "string" },
    "human-cursor": { type: "string" },
    "signal-cursor": { type: "string" },
    env: { type: "string" },
    yes: { type: "boolean" },
    actor: { type: "string" },
    reason: { type: "string" },
    "request-id": { type: "string" },
    ...HELP_OPTION,
  },
  tui: { ...DATABASE_OPTIONS, env: { type: "string" }, ...HELP_OPTION },
  health: { ...DATABASE_OPTIONS, json: { type: "boolean" }, ...HELP_OPTION },
} as const;

export interface CliCommand {
  /**
   * What an operator types after `workhorse`, for example `schema status`.
   *
   * It is also the command's key in {@link CLI_OPTIONS}. `admin` is the one set two names reach:
   * every subcommand parses through it, because `admin` parses before it knows which one ran.
   */
  readonly name: string;
  /** Positional arguments, in order, named as the usage text names them. */
  readonly positionals: readonly string[];
}

/**
 * The nine commands an operator runs.
 *
 * `workhorse` alone and `workhorse schema` alone print help and run nothing, so neither is a
 * command. Each `schema` action is its own command because each takes its own options.
 */
export const CLI_COMMANDS = [
  { name: "init", positionals: [] },
  { name: "schema install", positionals: [] },
  { name: "schema migrate", positionals: [] },
  { name: "schema status", positionals: [] },
  { name: "worker", positionals: [] },
  { name: "dashboard", positionals: [] },
  { name: "admin", positionals: ["command"] },
  { name: "tui", positionals: [] },
  { name: "health", positionals: [] },
] as const satisfies readonly CliCommand[];

/** One of the nine names {@link CLI_COMMANDS} declares. */
export type CliCommandName = (typeof CLI_COMMANDS)[number]["name"];

/** The three `schema` actions, in the order the group's help lists them. */
export const SCHEMA_ACTIONS = ["install", "migrate", "status"] as const;
export type SchemaAction = (typeof SCHEMA_ACTIONS)[number];

export interface AdminCommand {
  /** What an operator types after `workhorse admin`, for example `pause-worker`. */
  readonly name: string;
  /**
   * Whether the command mutates.
   *
   * A mutating command requires `--env` naming the target database and a confirmation, so the two
   * halves of the `admin` surface break differently: moving a command across this line changes
   * what an operator must pass.
   */
  readonly mutates: boolean;
  readonly positionals: readonly string[];
}

/** The eighteen `admin` subcommands, inspection before mutation as the help lists them. */
export const ADMIN_COMMANDS = [
  { name: "jobs", mutates: false, positionals: [] },
  { name: "job", mutates: false, positionals: ["job-id"] },
  { name: "timeline", mutates: false, positionals: ["job-id"] },
  { name: "checkpoints", mutates: false, positionals: ["job-id"] },
  { name: "waits", mutates: false, positionals: ["job-id"] },
  { name: "external-waits", mutates: false, positionals: [] },
  { name: "failures", mutates: false, positionals: [] },
  { name: "queues", mutates: false, positionals: [] },
  { name: "schedules", mutates: false, positionals: [] },
  { name: "workers", mutates: false, positionals: [] },
  { name: "maintenance", mutates: false, positionals: [] },
  { name: "cancel", mutates: true, positionals: ["job-id"] },
  { name: "redrive", mutates: true, positionals: ["job-id"] },
  { name: "pause", mutates: true, positionals: ["queue"] },
  { name: "resume", mutates: true, positionals: ["queue"] },
  { name: "purge", mutates: true, positionals: ["queue"] },
  { name: "pause-worker", mutates: true, positionals: ["worker-id"] },
  { name: "resume-worker", mutates: true, positionals: ["worker-id"] },
] as const satisfies readonly AdminCommand[];

/** One of the eighteen names {@link ADMIN_COMMANDS} declares. */
export type AdminCommandName = (typeof ADMIN_COMMANDS)[number]["name"];

/**
 * Exit code for malformed usage: `EX_USAGE` from sysexits, so automation can tell a wrong command
 * from a wrong answer.
 */
export const USAGE_EXIT_CODE = 64;

/** Exit code for queue degradation, which `health` reports and nothing else produces. */
export const DEGRADED_EXIT_CODE = 2;

/**
 * What each exit code means.
 *
 * A script branches on these numbers, so changing what one means breaks it as surely as renaming a
 * flag. 0 and 1 carry no constant because they are the shell's own convention rather than something
 * this CLI invented; the other two are named above and used where they are produced.
 *
 * The root help renders this list, so the sentence an operator reads and the sentence `api/cli.txt`
 * records are the same one.
 */
export const CLI_EXIT_CODES: readonly { readonly code: number; readonly meaning: string }[] = [
  { code: 0, meaning: "Success." },
  {
    code: 1,
    meaning: "Runtime failure, a refusal, a missing target, or a rejected schema or server.",
  },
  { code: DEGRADED_EXIT_CODE, meaning: "Queue degradation reported by health." },
  {
    code: USAGE_EXIT_CODE,
    meaning: "Usage error, including an unknown command, an unknown flag, or a missing value.",
  },
];

/** What `admin pause` and `admin resume` print under `--json`. */
interface AdminQueuePauseReport {
  readonly queue: string;
  readonly paused: boolean;
}

/** What `admin purge` prints under `--json`. */
interface AdminQueuePurgeReport {
  readonly queue: string;
  readonly deletedCount: number;
}

/**
 * The payload each `--json` command writes, keyed by the command an operator types.
 *
 * Every writer annotates its call with the entry for its own command, so the compiler refuses a
 * payload that is not this type and the snapshot's field list cannot drift from what the command
 * emits. A command that lists and also shows one record states both shapes: `--name` narrows
 * `checkpoints` and `waits` from the list to one entry.
 */
export interface CliJsonPayloads {
  readonly "schema status": SchemaStatusReport;
  readonly health: QueueHealth;
  readonly "admin jobs": JobListPage;
  readonly "admin job": JobSnapshot;
  readonly "admin timeline": JobTimelinePage;
  readonly "admin checkpoints": readonly JobCheckpoint[] | JobCheckpoint;
  readonly "admin waits": readonly JobWait[] | JobWait;
  readonly "admin external-waits": AdminExternalWaits;
  readonly "admin failures": DeadLetterPage;
  readonly "admin queues": readonly AdminQueueStatus[];
  readonly "admin schedules": readonly StoredSchedule[];
  readonly "admin workers": readonly WorkerRegistryEntry[];
  readonly "admin maintenance": AdminMaintenanceState;
  readonly "admin cancel": CancelResult;
  readonly "admin redrive": RedriveResult;
  readonly "admin pause": AdminQueuePauseReport;
  readonly "admin resume": AdminQueuePauseReport;
  readonly "admin purge": AdminQueuePurgeReport;
  readonly "admin pause-worker": WorkerPauseResult;
  readonly "admin resume-worker": WorkerPauseResult;
}
