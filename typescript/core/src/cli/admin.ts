import { randomUUID } from "node:crypto";
import readline from "node:readline/promises";
import { Pool } from "pg";
import { PurgeIdempotencyConflictError } from "../admin.js";
import {
  MAX_EXTERNAL_WAIT_LIST_SIZE,
  MAX_TASK_QUERY_PAGE_SIZE,
  MAX_REDRIVE_BATCH_SIZE,
} from "../types.js";
import type { DeadLetterFilter, TaskListQuery, TaskState } from "../types.js";
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
  TASKS_TABLE_HEADERS,
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
  taskDetailLines,
  tasksTableRows,
  maintenanceLines,
  queuesTableRows,
  schedulesTableRows,
  timelineTableRows,
  toAdminJson,
  waitDetailLines,
  waitsTableRows,
  workersTableRows,
} from "./admin-format.js";
import {
  continuationHint,
  parseCursor,
  parseDateRange,
  readDeliveryPayload,
} from "./admin-input.js";
import {
  validateExternalWaitDeliveryRequest,
  validateExternalWaitName,
  encodeExternalWaitValue,
} from "../queue/external-waits.js";
import { ADMIN_COMMANDS, CLI_OPTIONS } from "./surface.js";

const ADMIN_HELP = `Usage: workhorse admin <command> [options]

Inspection commands (safe, read-only):
  tasks         List tasks newest-first with lifecycle filters.
  task <id>     Show one task snapshot.
  timeline <id>
               Show one task's merged event and attempt timeline.
  checkpoints <task-id>
               List one task's restart-boundary checkpoints, or one of them with --name.
  waits <task-id>
               List one task's durable timer waits, or one of them with --name.
  external-waits
               List every pending human decision and signal wait across the fleet.
  failures     List terminal failures (dead letters).
  queues       List per-queue dispatch pressure and pause state.
  schedules    List enabled recurring schedules.
  workers      List durable worker registrations.
  maintenance  Show the maintenance and retention policies with provenance.

Guarded commands (mutate; require --env and confirmation):
  cancel <task-id>     Request cooperative cancellation of one task.
  redrive <task-id>    Redrive one terminal failure as a new task.
  redrive-many       Recover one oldest-first page of failures; --dry-run previews without writes.
  signal <task-id>    Deliver JSON to the signal wait selected by --name.
  complete-human <task-id>
                     Answer the human decision selected by --name.
  pause <queue>       Pause claiming for one queue.
  resume <queue>      Resume claiming for one queue.
  purge <queue>       Delete one queue's non-active tasks.
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
                     cancel, signal, and complete-human.
  --request-id <id>  Request identity recorded with the mutation (default: a random UUID).
                     Redrive and purge additionally use it for idempotency. Required explicitly
                     for redrive-many execution, signal, and complete-human; reuse on retries.
  --dry-run         Preview redrive-many without --env or confirmation; --reason is still required.
  --payload-json <json>
                     Signal or human decision value, including JSON null, false, and scalar values.
  --payload-file <path>
                     Read the delivery value from a JSON file instead of --payload-json.

Listing options:
  --queue <name>     Filter by queue.
  --type <type>      Filter by task type.
  --state <state>    Filter tasks by lifecycle state; repeatable or comma-separated.
  --limit <count>    Page size, at most 1000 for tasks, timeline, failures, and redrive-many.
  --cursor <json>   Continue tasks, timeline, failures, or redrive-many from its own nextCursor.
                     Keep filters unchanged; failure listings descend and bulk recovery ascends.
  --created-after <timestamp>, --created-before <timestamp>
                     Filter tasks by creation time (inclusive lower, exclusive upper bound).
  --finished-after <timestamp>, --finished-before <timestamp>
                     Filter failures or redrive-many by finish time (same bounds).
                     Timestamps must include a timezone.
  --tag <tag>       Require every supplied tag on failures or redrive-many; repeatable.
  --error-name <name>
                     Filter failures or redrive-many by the exact error name.
  --namespace <ns>   Filter schedules by namespace; repeatable or comma-separated.
  --name <name>      Show one named checkpoint or wait instead of the list.
  --human-cursor <json>
                     Continue external-waits from a printed human "nextCursor" object.
  --signal-cursor <json>
                     Continue external-waits from a printed signal "nextCursor" object.

The fallback database URL order is WORKHORSE_DATABASE_URL, then DATABASE_URL. Guarded commands
exit 1 when they refuse or when the target does not exist; malformed usage exits 64.
`;

const TASK_STATES: readonly TaskState[] = [
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

function parseStates(values: readonly string[] | undefined): TaskState[] | undefined {
  const states = splitRepeatable(values);
  if (states.length === 0) return undefined;
  for (const state of states) {
    if (!TASK_STATES.includes(state as TaskState)) {
      throw new CliUsageError(
        `Unknown task state: ${state}. Known states: ${TASK_STATES.join(", ")}`,
      );
    }
  }
  return [...new Set(states)] as TaskState[];
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
    `${flag} must be a JSON "nextCursor" object with string createdAt, taskId, and name fields`,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw malformed;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw malformed;
  const cursor = parsed as Record<string, unknown>;
  const fields = ["createdAt", "taskId", "name"] as const;
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
  // Never silently ignore a preview or selection flag on a mutating command.
  const scopedOptions: Record<string, readonly string[]> = {
    cursor: ["tasks", "timeline", "failures", "redrive-many"],
    "created-after": ["tasks"],
    "created-before": ["tasks"],
    "finished-after": ["failures", "redrive-many"],
    "finished-before": ["failures", "redrive-many"],
    tag: ["failures", "redrive-many"],
    "error-name": ["failures", "redrive-many"],
    "dry-run": ["redrive-many"],
    "payload-json": ["signal", "complete-human"],
    "payload-file": ["signal", "complete-human"],
    state: ["tasks"],
    namespace: ["schedules"],
    limit: ["tasks", "timeline", "failures", "redrive-many", "external-waits"],
    queue: ["tasks", "failures", "redrive-many"],
    type: ["tasks", "failures", "redrive-many"],
    name: ["checkpoints", "waits", "signal", "complete-human"],
    "human-cursor": ["external-waits"],
    "signal-cursor": ["external-waits"],
  };
  for (const [flag, commands] of Object.entries(scopedOptions)) {
    if (values[flag as keyof typeof values] !== undefined && !commands.includes(command)) {
      throw new CliUsageError(`admin ${command} does not support --${flag}`);
    }
  }
  const definition = ADMIN_COMMANDS.find((entry) => entry.name === command)!;
  if (definition.positionals.length === 0 && positionals.length > 0) {
    throw new CliUsageError(`Unexpected admin ${command} argument: ${positionals[0]}`);
  }
  const limit =
    values.limit === undefined ? undefined : parsePositiveInteger(values.limit, "--limit");
  const maximum =
    command === "external-waits"
      ? MAX_EXTERNAL_WAIT_LIST_SIZE
      : command === "redrive-many"
        ? MAX_REDRIVE_BATCH_SIZE
        : MAX_TASK_QUERY_PAGE_SIZE;
  if (limit !== undefined && limit > maximum) {
    throw new CliUsageError(`admin ${command} --limit must be at most ${maximum}`);
  }
  const [createdAfter, createdBefore] = parseDateRange(
    values["created-after"],
    values["created-before"],
    "created",
  );
  const [finishedAfter, finishedBefore] = parseDateRange(
    values["finished-after"],
    values["finished-before"],
    "finished",
  );
  const failureFilter: DeadLetterFilter = {
    queue: values.queue,
    type: values.type,
    tags: values.tag,
    errorName: values["error-name"],
    finishedAfter,
    finishedBefore,
  };
  const json = values.json ?? false;
  const pool = new Pool({ connectionString: resolveDatabaseUrl(values) });
  const client = new WorkhorseAdminClient(pool);
  try {
    if (command === "tasks") {
      const query: TaskListQuery = {
        queue: values.queue,
        type: values.type,
        states: parseStates(values.state),
        createdAfter,
        createdBefore,
        cursor: parseCursor(values.cursor, ["createdAt", "taskId", "signature"]),
        limit,
      };
      const page = await client.listTasks(query);
      io.out(
        json
          ? toAdminJson("admin tasks", page)
          : `${formatTable(TASKS_TABLE_HEADERS, tasksTableRows(page.items))}\n${continuationHint(page.nextCursor)}`,
      );
      return;
    }
    if (command === "task") {
      const taskId = requirePositional(positionals, command, "task-id");
      const snapshot = await client.getTask(taskId);
      if (snapshot === null) {
        io.error(`Task ${taskId} was not found.\n`);
        process.exitCode = 1;
        return;
      }
      io.out(
        json ? toAdminJson("admin task", snapshot) : `${taskDetailLines(snapshot).join("\n")}\n`,
      );
      return;
    }
    if (command === "timeline") {
      const taskId = requirePositional(positionals, command, "task-id");
      const cursor = parseCursor(values.cursor, ["taskId", "occurredAt", "kind", "recordId"]);
      if (
        cursor !== undefined &&
        (cursor.taskId !== taskId || (cursor.kind !== "event" && cursor.kind !== "attempt"))
      ) {
        throw new CliUsageError("--cursor must belong to this task and have kind event or attempt");
      }
      const page = await client.getTaskTimeline(taskId, {
        limit,
        cursor:
          cursor === undefined
            ? undefined
            : { ...cursor, kind: cursor.kind as "event" | "attempt" },
      });
      io.out(
        json
          ? toAdminJson("admin timeline", page)
          : `${formatTable(TIMELINE_TABLE_HEADERS, timelineTableRows(page.items))}\n${continuationHint(page.nextCursor)}`,
      );
      return;
    }
    if (command === "checkpoints") {
      const taskId = requirePositional(positionals, command, "task-id");
      if (values.name !== undefined) {
        const checkpoint = await client.getCheckpoint(taskId, values.name);
        if (checkpoint === null) {
          io.error(`Task ${taskId} has no checkpoint named ${values.name}.\n`);
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
      const checkpoints = await client.listCheckpoints(taskId);
      io.out(
        json
          ? toAdminJson("admin checkpoints", checkpoints)
          : `${formatTable(CHECKPOINTS_TABLE_HEADERS, checkpointsTableRows(checkpoints))}\n`,
      );
      return;
    }
    if (command === "waits") {
      const taskId = requirePositional(positionals, command, "task-id");
      if (values.name !== undefined) {
        const wait = await client.getWait(taskId, values.name);
        if (wait === null) {
          io.error(`Task ${taskId} has no wait named ${values.name}.\n`);
          process.exitCode = 1;
          return;
        }
        io.out(json ? toAdminJson("admin waits", wait) : `${waitDetailLines(wait).join("\n")}\n`);
        return;
      }
      const waits = await client.listWaits(taskId);
      io.out(
        json
          ? toAdminJson("admin waits", waits)
          : `${formatTable(WAITS_TABLE_HEADERS, waitsTableRows(waits))}\n`,
      );
      return;
    }
    if (command === "external-waits") {
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
        ...failureFilter,
        limit,
        cursor: parseCursor(values.cursor, ["finishedAt", "taskId"]),
      });
      io.out(
        json
          ? toAdminJson("admin failures", page)
          : `${formatTable(FAILURES_TABLE_HEADERS, failuresTableRows(page.items))}\n${continuationHint(page.nextCursor)}`,
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

    // Every mutation passes through confirmMutation. Bulk preview is the read-only exception.
    const actor = values.actor ?? "workhorse-admin";
    if (command === "redrive-many") {
      if (!values.reason?.trim())
        throw new CliUsageError("admin redrive-many requires --reason <text>");
      if (!values["dry-run"] && !values["request-id"]?.trim()) {
        throw new CliUsageError(
          "admin redrive-many requires --request-id <id> for replayable recovery",
        );
      }
      const request = {
        requestedBy: actor,
        reason: values.reason,
        requestId: values["request-id"] ?? "workhorse-admin-preview",
      };
      const options = { limit, cursor: parseCursor(values.cursor, ["finishedAt", "taskId"]) };
      const environment = values["dry-run"]
        ? null
        : await confirmMutation(client, io, values, command, values.queue ?? "all queues");
      if (!values["dry-run"] && environment === null) return;
      const page =
        environment === null
          ? await client.previewRedrive(failureFilter, request, options)
          : await client.redriveMany(environment, failureFilter, request, options);
      io.out(
        json
          ? toAdminJson("admin redrive-many", page)
          : `${formatTable(
              ["SOURCE", "TARGET", "STATUS"],
              page.results.map((result) => [
                result.sourceTaskId,
                result.targetTaskId ?? "-",
                result.status,
              ]),
            )}\n${continuationHint(page.nextCursor)}`,
      );
      if (
        page.results.some(
          (result) => result.status === "not_found" || result.status === "not_failed",
        )
      )
        process.exitCode = 1;
      return;
    }
    if (command === "signal" || command === "complete-human") {
      const taskId = requirePositional(positionals, command, "task-id");
      if (!values.name) throw new CliUsageError(`admin ${command} requires --name <name>`);
      if (!values["request-id"]?.trim())
        throw new CliUsageError(`admin ${command} requires --request-id <id>`);
      const payload = await readDeliveryPayload(values["payload-json"], values["payload-file"]);
      const request = { requestedBy: actor, idempotencyKey: values["request-id"] };
      try {
        validateExternalWaitName(values.name, "Delivery");
        validateExternalWaitDeliveryRequest(request, "Delivery");
        encodeExternalWaitValue(payload, "Delivery payload");
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError)
          throw new CliUsageError(error.message);
        throw error;
      }
      const environment = await confirmMutation(client, io, values, command, taskId);
      if (environment === null) return;
      const result =
        command === "signal"
          ? await client.sendSignal(environment, taskId, values.name, payload, request)
          : await client.completeHumanWait(environment, taskId, values.name, payload, request);
      const accepted =
        result.status === "delivered" ||
        result.status === "completed" ||
        result.status === "duplicate";
      if (json) {
        if ("deliveredAt" in result) io.out(toAdminJson("admin signal", result));
        else io.out(toAdminJson("admin complete-human", result));
      } else {
        const message = `${command} ${taskId} / ${values.name}: ${result.status}.\n`;
        if (accepted) io.out(message);
        else io.error(message);
      }
      if (!accepted) process.exitCode = 1;
      return;
    }
    if (command === "cancel") {
      const taskId = requirePositional(positionals, command, "task-id");
      const environment = await confirmMutation(client, io, values, "cancel", taskId);
      if (environment === null) return;
      const result = await client.cancel(environment, taskId, {
        requestedBy: actor,
        reason: values.reason,
      });
      if (json) io.out(toAdminJson("admin cancel", result));
      else if (result.status === "canceled") io.out(`Canceled task ${taskId}.\n`);
      else if (result.status === "cancel_requested") {
        io.out(`Requested cooperative cancellation of active task ${taskId}.\n`);
      } else if (result.status === "already_terminal") {
        io.out(`Task ${taskId} is already terminal (${result.state ?? "unknown"}).\n`);
      } else io.error(`Task ${taskId} was not found.\n`);
      if (result.status === "already_terminal" || result.status === "not_found") {
        process.exitCode = 1;
      }
      return;
    }
    if (command === "redrive") {
      const taskId = requirePositional(positionals, command, "task-id");
      if (!values.reason) throw new CliUsageError("admin redrive requires --reason <text>");
      const environment = await confirmMutation(client, io, values, "redrive", taskId);
      if (environment === null) return;
      const result = await client.redrive(environment, taskId, {
        requestedBy: actor,
        reason: values.reason,
        requestId: values["request-id"] ?? randomUUID(),
      });
      if (json) io.out(toAdminJson("admin redrive", result));
      else if (result.status === "redriven" || result.status === "replayed") {
        io.out(
          `Redrove task ${taskId} as ${result.targetTaskId ?? "unknown"} (${result.status}).\n`,
        );
      } else if (result.status === "not_failed") {
        io.error(
          `Task ${taskId} is not a terminal failure (state ${result.sourceState ?? "unknown"}).\n`,
        );
      } else io.error(`Task ${taskId} was not found.\n`);
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
      else io.out(`Purged ${deletedCount} task(s) from queue ${queueName}.\n`);
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
