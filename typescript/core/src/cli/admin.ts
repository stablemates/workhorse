import { randomUUID } from "node:crypto";
import readline from "node:readline/promises";
import { Pool } from "pg";
import { PurgeIdempotencyConflictError } from "../admin.js";
import { MAX_EXTERNAL_WAIT_LIST_SIZE } from "../types.js";
import type { JobListQuery, JobState } from "../types.js";
import type { ExternalWaitCursor } from "../queue/external-waits.js";
import { CliUsageError, parseCommandArgs, resolveDatabaseUrl } from "./arguments.js";
import {
  AdminSafetyError,
  WorkhorseAdminClient,
  type ConfirmedEnvironment,
} from "./admin-client.js";
import {
  CHECKPOINTS_TABLE_HEADERS,
  EXTERNAL_WAITS_TABLE_HEADERS,
  FAILURES_TABLE_HEADERS,
  JOBS_TABLE_HEADERS,
  QUEUES_TABLE_HEADERS,
  SCHEDULES_TABLE_HEADERS,
  TIMELINE_TABLE_HEADERS,
  WAITS_TABLE_HEADERS,
  WORKERS_TABLE_HEADERS,
  checkpointDetailLines,
  checkpointsTableRows,
  externalWaitsTableRows,
  failuresTableRows,
  formatTable,
  jobDetailLines,
  jobsTableRows,
  maintenanceLines,
  queuesTableRows,
  schedulesTableRows,
  timelineTableRows,
  toAdminJson,
  waitDetailLines,
  waitsTableRows,
  workersTableRows,
} from "./admin-format.js";
import { ADMIN_COMMANDS, CLI_OPTIONS } from "./surface.js";

const ADMIN_HELP = `Usage: workhorse admin <command> [options]

Inspection commands (safe, read-only):
  jobs         List jobs newest-first with lifecycle filters.
  job <id>     Show one job snapshot.
  timeline <id>
               Show one job's merged event and attempt timeline.
  checkpoints <job-id>
               List one job's restart-boundary checkpoints, or one of them with --name.
  waits <job-id>
               List one job's durable timer waits, or one of them with --name.
  external-waits
               List every pending human decision and signal wait across the fleet.
  failures     List terminal failures (dead letters).
  queues       List per-queue dispatch pressure and pause state.
  schedules    List enabled recurring schedules.
  workers      List durable worker registrations.
  maintenance  Show the maintenance and retention policies with provenance.

Guarded commands (mutate; require --env and confirmation):
  cancel <job-id>     Request cooperative cancellation of one job.
  redrive <job-id>    Redrive one terminal failure as a new job.
  pause <queue>       Pause claiming for one queue.
  resume <queue>      Resume claiming for one queue.
  purge <queue>       Delete one queue's non-active jobs.
  pause-worker <worker-id>
                      Stop one registered worker from claiming.
  resume-worker <worker-id>
                      Let one registered worker claim again.

Common options:
  --database-url <url>  Database URL. This takes precedence over all other sources.
  --json                Emit machine-readable JSON instead of tables.
  --help, -h            Show help for a command.

Guarded-command options:
  --env <database>   Required. Must equal the connected database's own name.
  --yes              Skip the interactive confirmation prompt.
  --actor <name>     Attribution recorded for the mutation (default: workhorse-admin).
  --reason <text>    Reason recorded for the mutation. Required for every guarded command except
                     cancel.
  --request-id <id>  Request identity recorded with the mutation (default: a random UUID).
                     Redrive and purge additionally use it for idempotency.

Listing options:
  --queue <name>     Filter by queue.
  --type <type>      Filter by job type.
  --state <state>    Filter jobs by lifecycle state; repeatable or comma-separated.
  --limit <count>    Page size.
  --namespace <ns>   Filter schedules by namespace; repeatable or comma-separated.
  --name <name>      Show one named checkpoint or wait instead of the list.
  --human-cursor <json>
                     Continue external-waits from a printed human "nextCursor" object.
  --signal-cursor <json>
                     Continue external-waits from a printed signal "nextCursor" object.

The fallback database URL order is WORKHORSE_DATABASE_URL, then DATABASE_URL. Guarded commands
exit 1 when they refuse or when the target does not exist; malformed usage exits 64.
`;

const JOB_STATES: readonly JobState[] = [
  "blocked",
  "scheduled",
  "ready",
  "active",
  "succeeded",
  "failed",
  "canceled",
];

// Derived rather than restated, so removing or renaming a subcommand in `surface.ts` stops this
// dispatch from accepting it and `api/cli.txt` cannot describe a command that no longer runs.
const READ_COMMANDS = new Set<string>(
  ADMIN_COMMANDS.filter((entry) => !entry.mutates).map((entry) => entry.name),
);
const MUTATION_COMMANDS = new Set<string>(
  ADMIN_COMMANDS.filter((entry) => entry.mutates).map((entry) => entry.name),
);

interface AdminIo {
  out(text: string): void;
  error(text: string): void;
  /** Interactive confirmation. Returns the operator's exact answer, or null when not a TTY. */
  confirm(question: string): Promise<string | null>;
}

function defaultIo(): AdminIo {
  return {
    out: (text) => process.stdout.write(text),
    error: (text) => process.stderr.write(text),
    confirm: async (question) => {
      if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
      const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await prompt.question(question);
      } finally {
        prompt.close();
      }
    },
  };
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`${flag} must be a positive safe integer`);
  }
  return parsed;
}

function splitRepeatable(values: readonly string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => value.split(",")).filter((value) => value.length > 0);
}

function parseStates(values: readonly string[] | undefined): JobState[] | undefined {
  const states = splitRepeatable(values);
  if (states.length === 0) return undefined;
  for (const state of states) {
    if (!JOB_STATES.includes(state as JobState)) {
      throw new CliUsageError(
        `Unknown job state: ${state}. Known states: ${JOB_STATES.join(", ")}`,
      );
    }
  }
  return states as JobState[];
}

/**
 * Read back the opaque continuation an earlier `--json` page printed.
 *
 * The cursor is the dashboard's own {@link ExternalWaitCursor}, so it round-trips as the exact
 * JSON object the previous page emitted rather than a CLI-private encoding.
 */
function parseExternalWaitCursor(
  value: string | undefined,
  flag: string,
): ExternalWaitCursor | undefined {
  if (value === undefined) return undefined;
  const malformed = new CliUsageError(
    `${flag} must be a JSON "nextCursor" object with string createdAt, jobId, and name fields`,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw malformed;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw malformed;
  const cursor = parsed as Record<string, unknown>;
  const fields = ["createdAt", "jobId", "name"] as const;
  if (Object.keys(cursor).length !== fields.length) throw malformed;
  for (const field of fields) {
    if (typeof cursor[field] !== "string" || cursor[field] === "") throw malformed;
  }
  return cursor as unknown as ExternalWaitCursor;
}

function requirePositional(positionals: readonly string[], command: string, name: string): string {
  const target = positionals[0];
  if (target === undefined) throw new CliUsageError(`admin ${command} requires a <${name}>`);
  if (positionals.length > 1) {
    throw new CliUsageError(`Unexpected admin ${command} argument: ${positionals[1]}`);
  }
  return target;
}

/**
 * The shared confirmation gate for guarded commands.
 *
 * The environment check runs inside the client; this adds the human confirmation: the operator
 * either passed --yes or retypes the target identifier at an interactive prompt.
 */
async function confirmMutation(
  client: WorkhorseAdminClient,
  io: AdminIo,
  options: { env?: string; yes?: boolean },
  action: string,
  target: string,
): Promise<ConfirmedEnvironment | null> {
  if (options.env === undefined) {
    throw new CliUsageError(
      `admin ${action} requires --env <database> naming the target database explicitly`,
    );
  }
  const environment = await client.confirmEnvironment(options.env);
  if (options.yes) return environment;
  const answer = await io.confirm(
    `About to ${action} "${target}" in database "${environment.database}". ` +
      `Type "${target}" to confirm: `,
  );
  if (answer === null) {
    throw new CliUsageError(`admin ${action} requires --yes when not running interactively`);
  }
  if (answer.trim() !== target) {
    io.error("Confirmation did not match; nothing was changed.\n");
    process.exitCode = 1;
    return null;
  }
  return environment;
}

export async function runAdminCommand(
  args: readonly string[],
  io: AdminIo = defaultIo(),
): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    io.out(ADMIN_HELP);
    return;
  }
  if (!READ_COMMANDS.has(command) && !MUTATION_COMMANDS.has(command)) {
    throw new CliUsageError(`Unknown admin command: ${command}`);
  }
  const { values, positionals } = parseCommandArgs(`admin ${command}`, {
    args: args.slice(1),
    options: CLI_OPTIONS.admin,
    strict: true,
    allowPositionals: true,
  });
  if (values.help) {
    io.out(ADMIN_HELP);
    return;
  }
  const limit =
    values.limit === undefined ? undefined : parsePositiveInteger(values.limit, "--limit");
  const json = values.json ?? false;
  const pool = new Pool({ connectionString: resolveDatabaseUrl(values) });
  const client = new WorkhorseAdminClient(pool);
  try {
    if (command === "jobs") {
      const query: JobListQuery = {
        queue: values.queue,
        type: values.type,
        states: parseStates(values.state),
        limit,
      };
      const page = await client.listJobs(query);
      io.out(
        json
          ? toAdminJson("admin jobs", page)
          : `${formatTable(JOBS_TABLE_HEADERS, jobsTableRows(page.items))}\n`,
      );
      return;
    }
    if (command === "job") {
      const jobId = requirePositional(positionals, command, "job-id");
      const snapshot = await client.getJob(jobId);
      if (snapshot === null) {
        io.error(`Job ${jobId} was not found.\n`);
        process.exitCode = 1;
        return;
      }
      io.out(
        json ? toAdminJson("admin job", snapshot) : `${jobDetailLines(snapshot).join("\n")}\n`,
      );
      return;
    }
    if (command === "timeline") {
      const jobId = requirePositional(positionals, command, "job-id");
      const page = await client.getJobTimeline(jobId, { limit });
      io.out(
        json
          ? toAdminJson("admin timeline", page)
          : `${formatTable(TIMELINE_TABLE_HEADERS, timelineTableRows(page.items))}\n`,
      );
      return;
    }
    if (command === "checkpoints") {
      const jobId = requirePositional(positionals, command, "job-id");
      if (values.name !== undefined) {
        const checkpoint = await client.getCheckpoint(jobId, values.name);
        if (checkpoint === null) {
          io.error(`Job ${jobId} has no checkpoint named ${values.name}.\n`);
          process.exitCode = 1;
          return;
        }
        io.out(
          json
            ? toAdminJson("admin checkpoints", checkpoint)
            : `${checkpointDetailLines(checkpoint).join("\n")}\n`,
        );
        return;
      }
      const checkpoints = await client.listCheckpoints(jobId);
      io.out(
        json
          ? toAdminJson("admin checkpoints", checkpoints)
          : `${formatTable(CHECKPOINTS_TABLE_HEADERS, checkpointsTableRows(checkpoints))}\n`,
      );
      return;
    }
    if (command === "waits") {
      const jobId = requirePositional(positionals, command, "job-id");
      if (values.name !== undefined) {
        const wait = await client.getWait(jobId, values.name);
        if (wait === null) {
          io.error(`Job ${jobId} has no wait named ${values.name}.\n`);
          process.exitCode = 1;
          return;
        }
        io.out(json ? toAdminJson("admin waits", wait) : `${waitDetailLines(wait).join("\n")}\n`);
        return;
      }
      const waits = await client.listWaits(jobId);
      io.out(
        json
          ? toAdminJson("admin waits", waits)
          : `${formatTable(WAITS_TABLE_HEADERS, waitsTableRows(waits))}\n`,
      );
      return;
    }
    if (command === "external-waits") {
      if (positionals.length > 0) {
        throw new CliUsageError(`Unexpected admin external-waits argument: ${positionals[0]}`);
      }
      if (limit !== undefined && limit > MAX_EXTERNAL_WAIT_LIST_SIZE) {
        throw new CliUsageError(
          `admin external-waits --limit must be at most ${MAX_EXTERNAL_WAIT_LIST_SIZE}`,
        );
      }
      const waits = await client.externalWaits({
        limit,
        humanCursor: parseExternalWaitCursor(values["human-cursor"], "--human-cursor"),
        signalCursor: parseExternalWaitCursor(values["signal-cursor"], "--signal-cursor"),
      });
      io.out(
        json
          ? toAdminJson("admin external-waits", waits)
          : `${formatTable(EXTERNAL_WAITS_TABLE_HEADERS, externalWaitsTableRows(waits))}\n`,
      );
      return;
    }
    if (command === "failures") {
      const page = await client.listDeadLetters({
        queue: values.queue,
        type: values.type,
        limit,
      });
      io.out(
        json
          ? toAdminJson("admin failures", page)
          : `${formatTable(FAILURES_TABLE_HEADERS, failuresTableRows(page.items))}\n`,
      );
      return;
    }
    if (command === "queues") {
      const queues = await client.queues();
      io.out(
        json
          ? toAdminJson("admin queues", queues)
          : `${formatTable(QUEUES_TABLE_HEADERS, queuesTableRows(queues))}\n`,
      );
      return;
    }
    if (command === "schedules") {
      const namespaces = splitRepeatable(values.namespace);
      const schedules = await client.schedules(namespaces.length === 0 ? undefined : namespaces);
      io.out(
        json
          ? toAdminJson("admin schedules", schedules)
          : `${formatTable(SCHEDULES_TABLE_HEADERS, schedulesTableRows(schedules))}\n`,
      );
      return;
    }
    if (command === "workers") {
      const workers = await client.workers();
      io.out(
        json
          ? toAdminJson("admin workers", workers)
          : `${formatTable(WORKERS_TABLE_HEADERS, workersTableRows(workers))}\n`,
      );
      return;
    }
    if (command === "maintenance") {
      const state = await client.maintenance();
      io.out(
        json ? toAdminJson("admin maintenance", state) : `${maintenanceLines(state).join("\n")}\n`,
      );
      return;
    }

    // Guarded commands below. Every path passes through confirmMutation, which owns both the
    // explicit-environment check and the human confirmation.
    const actor = values.actor ?? "workhorse-admin";
    if (command === "cancel") {
      const jobId = requirePositional(positionals, command, "job-id");
      const environment = await confirmMutation(client, io, values, "cancel", jobId);
      if (environment === null) return;
      const result = await client.cancel(environment, jobId, {
        requestedBy: actor,
        reason: values.reason,
      });
      if (json) io.out(toAdminJson("admin cancel", result));
      else if (result.status === "canceled") io.out(`Canceled job ${jobId}.\n`);
      else if (result.status === "cancel_requested") {
        io.out(`Requested cooperative cancellation of active job ${jobId}.\n`);
      } else if (result.status === "already_terminal") {
        io.out(`Job ${jobId} is already terminal (${result.state ?? "unknown"}).\n`);
      } else io.error(`Job ${jobId} was not found.\n`);
      if (result.status === "already_terminal" || result.status === "not_found") {
        process.exitCode = 1;
      }
      return;
    }
    if (command === "redrive") {
      const jobId = requirePositional(positionals, command, "job-id");
      if (!values.reason) throw new CliUsageError("admin redrive requires --reason <text>");
      const environment = await confirmMutation(client, io, values, "redrive", jobId);
      if (environment === null) return;
      const result = await client.redrive(environment, jobId, {
        requestedBy: actor,
        reason: values.reason,
        requestId: values["request-id"] ?? randomUUID(),
      });
      if (json) io.out(toAdminJson("admin redrive", result));
      else if (result.status === "redriven" || result.status === "replayed") {
        io.out(`Redrove job ${jobId} as ${result.targetJobId ?? "unknown"} (${result.status}).\n`);
      } else if (result.status === "not_failed") {
        io.error(
          `Job ${jobId} is not a terminal failure (state ${result.sourceState ?? "unknown"}).\n`,
        );
      } else io.error(`Job ${jobId} was not found.\n`);
      if (result.status === "not_found" || result.status === "not_failed") process.exitCode = 1;
      return;
    }
    if (command === "pause-worker" || command === "resume-worker") {
      const workerId = requirePositional(positionals, command, "worker-id");
      if (!values.reason) throw new CliUsageError(`admin ${command} requires --reason <text>`);
      const environment = await confirmMutation(client, io, values, command, workerId);
      if (environment === null) return;
      const paused = command === "pause-worker";
      // The registry row is the pause, so the command reports the row the database now holds
      // rather than the intent it sent. A worker that already aged out has no row to report.
      const result = await client.setWorkerPaused(environment, workerId, paused, {
        requestedBy: actor,
        reason: values.reason,
        requestId: values["request-id"] ?? randomUUID(),
      });
      if (result === null) {
        io.error(`Worker ${workerId} is not registered.\n`);
        process.exitCode = 1;
        return;
      }
      if (json) {
        io.out(toAdminJson(paused ? "admin pause-worker" : "admin resume-worker", result));
      } else io.out(`${paused ? "Paused" : "Resumed"} worker ${workerId}.\n`);
      return;
    }
    const queueName = requirePositional(positionals, command, "queue");
    if (!values.reason) throw new CliUsageError(`admin ${command} requires --reason <text>`);
    const environment = await confirmMutation(client, io, values, command, queueName);
    if (environment === null) return;
    const request = {
      requestedBy: actor,
      reason: values.reason,
      requestId: values["request-id"] ?? randomUUID(),
    };
    if (command === "purge") {
      const deletedCount = await client.purgeQueue(environment, queueName, request);
      if (json) io.out(toAdminJson("admin purge", { queue: queueName, deletedCount }));
      else io.out(`Purged ${deletedCount} job(s) from queue ${queueName}.\n`);
      return;
    }
    if (command === "pause") await client.pauseQueue(environment, queueName, request);
    else await client.resumeQueue(environment, queueName, request);
    const paused = command === "pause";
    if (json) {
      io.out(toAdminJson(paused ? "admin pause" : "admin resume", { queue: queueName, paused }));
    } else io.out(`${paused ? "Paused" : "Resumed"} queue ${queueName}.\n`);
  } catch (error) {
    if (error instanceof AdminSafetyError || error instanceof PurgeIdempotencyConflictError) {
      io.error(`Refused: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await pool.end();
  }
}
