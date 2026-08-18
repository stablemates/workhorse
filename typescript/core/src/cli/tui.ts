import readline from "node:readline";
import { Pool } from "pg";
import type { DeadLetter, JobListItem, QueueHealth, WorkerRegistryEntry } from "../types.js";
import type { StoredSchedule } from "../queue/cron-schedules.js";
import {
  AdminSafetyError,
  WorkhorseAdminClient,
  type AdminQueueStatus,
  type ConfirmedEnvironment,
} from "./admin-client.js";
import {
  FAILURES_TABLE_HEADERS,
  JOBS_TABLE_HEADERS,
  QUEUES_TABLE_HEADERS,
  SCHEDULES_TABLE_HEADERS,
  WORKERS_TABLE_HEADERS,
  failuresTableRows,
  formatTable,
  healthLines,
  jobsTableRows,
  queuesTableRows,
  schedulesTableRows,
  workersTableRows,
} from "./admin-format.js";

export const TUI_REFRESH_INTERVAL_MS = 5_000;
/** Rows fetched per view. Small enough to render on one screen without paging. */
export const TUI_PAGE_SIZE = 50;

export type TuiViewName = "jobs" | "queues" | "schedules" | "failures" | "workers" | "health";

export const TUI_VIEW_ORDER: readonly TuiViewName[] = [
  "jobs",
  "queues",
  "schedules",
  "failures",
  "workers",
  "health",
];

export interface TuiPendingAction {
  kind: "pause" | "resume";
  queue: string;
}

/** Everything one frame renders from. The runtime mutates it; rendering never does. */
export interface TuiState {
  view: TuiViewName;
  database: string;
  /** Non-null only when the operator confirmed the environment at launch. */
  environment: ConfirmedEnvironment | null;
  jobs: JobListItem[];
  queues: AdminQueueStatus[];
  schedules: StoredSchedule[];
  failures: DeadLetter[];
  workers: WorkerRegistryEntry[];
  health: QueueHealth | null;
  selectedQueue: number;
  pendingAction: TuiPendingAction | null;
  message: string | null;
  refreshedAt: Date | null;
}

export function createTuiState(
  database: string,
  environment: ConfirmedEnvironment | null,
): TuiState {
  return {
    view: "queues",
    database,
    environment,
    jobs: [],
    queues: [],
    schedules: [],
    failures: [],
    workers: [],
    health: null,
    selectedQueue: 0,
    pendingAction: null,
    message: null,
    refreshedAt: null,
  };
}

function viewBody(state: TuiState): string[] {
  switch (state.view) {
    case "jobs":
      return formatTable(JOBS_TABLE_HEADERS, jobsTableRows(state.jobs)).split("\n");
    case "queues": {
      const rows = queuesTableRows(state.queues).map((row, index) =>
        [index === state.selectedQueue ? ">" : " "].concat(row),
      );
      return formatTable(["", ...QUEUES_TABLE_HEADERS], rows).split("\n");
    }
    case "schedules":
      return formatTable(SCHEDULES_TABLE_HEADERS, schedulesTableRows(state.schedules)).split("\n");
    case "failures":
      return formatTable(FAILURES_TABLE_HEADERS, failuresTableRows(state.failures)).split("\n");
    case "workers":
      return formatTable(WORKERS_TABLE_HEADERS, workersTableRows(state.workers)).split("\n");
    case "health":
      return state.health === null ? ["Loading health…"] : healthLines(state.health);
  }
}

function footer(state: TuiState): string {
  if (state.pendingAction !== null) {
    return `${state.pendingAction.kind} queue "${state.pendingAction.queue}"? y to confirm, any other key to cancel`;
  }
  const keys = "1 jobs  2 queues  3 schedules  4 failures  5 workers  6 health  r refresh  q quit";
  const queueKeys =
    state.view === "queues"
      ? state.environment === null
        ? "  ↑/↓ select (read-only: relaunch with --env to pause/resume)"
        : "  ↑/↓ select  p pause/resume"
      : "";
  return `${keys}${queueKeys}`;
}

/**
 * Render one full frame as plain text. Pure so tests can assert on frames without a terminal.
 * The caller owns clearing the screen and clipping to the real terminal height.
 */
export function renderTuiFrame(state: TuiState, columns = 120, rows = 40): string {
  const title =
    `workhorse tui — ${state.database}` +
    `${state.environment === null ? " (read-only)" : ""} — ${state.view}` +
    `${state.refreshedAt === null ? "" : ` — refreshed ${state.refreshedAt.toISOString().slice(11, 19)}Z`}`;
  const lines = [title, "".padEnd(Math.min(title.length, columns), "─"), ...viewBody(state)];
  if (state.message !== null) lines.push("", state.message);
  const clipped = lines.slice(0, Math.max(rows - 2, 3)).map((line) => line.slice(0, columns));
  clipped.push("", footer(state).slice(0, columns));
  return clipped.join("\n");
}

/** Apply one keypress to the state. Returns what the runtime should do next. */
export function handleTuiKey(
  state: TuiState,
  key: string,
): "quit" | "refresh" | "render" | "confirm" | "ignore" {
  if (state.pendingAction !== null) {
    if (key === "y") return "confirm";
    state.pendingAction = null;
    state.message = "Canceled; nothing was changed.";
    return "render";
  }
  if (key === "q" || key === "ctrl-c") return "quit";
  if (key === "r") return "refresh";
  const selectedView = TUI_VIEW_ORDER[Number(key) - 1];
  if (selectedView !== undefined) {
    state.view = selectedView;
    state.message = null;
    return "refresh";
  }
  if (state.view === "queues") {
    if (key === "up" || key === "k") {
      state.selectedQueue = Math.max(0, state.selectedQueue - 1);
      return "render";
    }
    if (key === "down" || key === "j") {
      state.selectedQueue = Math.min(Math.max(state.queues.length - 1, 0), state.selectedQueue + 1);
      return "render";
    }
    if (key === "p") {
      const selected = state.queues[state.selectedQueue];
      if (selected === undefined) return "ignore";
      if (state.environment === null) {
        state.message = "Read-only session. Relaunch with --env <database> to pause or resume.";
        return "render";
      }
      state.pendingAction = { kind: selected.paused ? "resume" : "pause", queue: selected.queue };
      return "render";
    }
  }
  return "ignore";
}

export async function refreshTuiState(
  client: WorkhorseAdminClient,
  state: TuiState,
): Promise<void> {
  switch (state.view) {
    case "jobs":
      state.jobs = (await client.listJobs({ limit: TUI_PAGE_SIZE })).items;
      break;
    case "queues":
      state.queues = await client.queues();
      state.selectedQueue = Math.min(state.selectedQueue, Math.max(state.queues.length - 1, 0));
      break;
    case "schedules":
      state.schedules = await client.schedules();
      break;
    case "failures":
      state.failures = (await client.listDeadLetters({ limit: TUI_PAGE_SIZE })).items;
      break;
    case "workers":
      state.workers = await client.workers();
      break;
    case "health":
      state.health = await client.health();
      break;
  }
  state.refreshedAt = new Date();
}

/** Run the confirmed pending action through the same guarded client methods the CLI uses. */
export async function applyTuiPendingAction(
  client: WorkhorseAdminClient,
  state: TuiState,
): Promise<void> {
  const action = state.pendingAction;
  state.pendingAction = null;
  if (action === null || state.environment === null) return;
  try {
    if (action.kind === "pause") await client.pauseQueue(state.environment, action.queue);
    else await client.resumeQueue(state.environment, action.queue);
    state.message = `${action.kind === "pause" ? "Paused" : "Resumed"} queue ${action.queue}.`;
  } catch (error) {
    state.message = `Failed to ${action.kind} ${action.queue}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

export interface TuiCommandOptions {
  databaseUrl: string;
  environment?: string;
}

export async function runTuiCommand(options: TuiCommandOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new AdminSafetyError("workhorse tui requires an interactive terminal");
  }
  const pool = new Pool({ connectionString: options.databaseUrl });
  const client = new WorkhorseAdminClient(pool);
  const environment =
    options.environment === undefined ? null : await client.confirmEnvironment(options.environment);
  const state = createTuiState(await client.targetDatabase(), environment);

  const output = process.stdout;
  output.write("\u001B[?1049h\u001B[?25l");
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let closed = false;
  const render = (): void => {
    if (closed) return;
    const frame = renderTuiFrame(state, output.columns ?? 120, output.rows ?? 40);
    output.write(`\u001B[H\u001B[2J${frame}`);
  };
  let refreshing = false;
  const refresh = async (): Promise<void> => {
    if (refreshing || closed) return;
    refreshing = true;
    try {
      await refreshTuiState(client, state);
    } catch (error) {
      state.message = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      refreshing = false;
    }
    render();
  };
  const timer = setInterval(() => void refresh(), TUI_REFRESH_INTERVAL_MS);

  await new Promise<void>((resolve) => {
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      output.write("\u001B[?25h\u001B[?1049l");
      resolve();
    };
    process.stdin.on(
      "keypress",
      (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
        const name = key.ctrl && key.name === "c" ? "ctrl-c" : (key.name ?? text ?? "");
        const outcome = handleTuiKey(state, name);
        if (outcome === "quit") close();
        else if (outcome === "refresh") void refresh();
        else if (outcome === "render") render();
        else if (outcome === "confirm") {
          void applyTuiPendingAction(client, state).then(refresh);
        }
      },
    );
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    void refresh();
  });
  await pool.end();
}
