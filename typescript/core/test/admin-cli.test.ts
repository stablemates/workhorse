import { describe, expect, it } from "vitest";
import type { AdminQueueStatus } from "../src/cli/admin-client.js";
import {
  adminJsonReplacer,
  formatDurationMs,
  formatTable,
  QUEUES_TABLE_HEADERS,
  queuesTableRows,
} from "../src/cli/admin-format.js";
import { createTuiState, handleTuiKey, renderTuiFrame, TUI_VIEW_ORDER } from "../src/cli/tui.js";

function queueStatus(overrides: Partial<AdminQueueStatus> = {}): AdminQueueStatus {
  return {
    queue: "default",
    paused: false,
    readyDepth: 3,
    scheduledDepth: 1,
    activeLeases: 2,
    blockedReadyDepth: 0,
    oldestReadyAgeMs: 42_000,
    concurrencyLimit: 8,
    concurrencyActive: 2,
    rateLimitPerSecond: null,
    rateLimitThrottledReadyDepth: 0,
    ...overrides,
  };
}

describe("admin formatting", () => {
  it("aligns table columns to the widest cell", () => {
    const table = formatTable(
      ["A", "LONG HEADER"],
      [
        ["wide-value", "x"],
        ["b", "y"],
      ],
    );
    expect(table).toBe(["A           LONG HEADER", "wide-value  x", "b           y"].join("\n"));
  });

  it("renders queue pressure and pause state in one row", () => {
    const rows = queuesTableRows([queueStatus({ paused: true })]);
    expect(rows).toEqual([["default", "yes", "3", "1", "2", "0", "42s", "2/8", "-"]]);
    expect(rows[0]).toHaveLength(QUEUES_TABLE_HEADERS.length);
  });

  it("formats durations into compact operator units", () => {
    expect(formatDurationMs(null)).toBe("-");
    expect(formatDurationMs(950)).toBe("950ms");
    expect(formatDurationMs(90_000)).toBe("2m");
    expect(formatDurationMs(3 * 24 * 60 * 60 * 1_000)).toBe("3d");
  });

  it("serializes bigint fence tokens and revisions as strings", () => {
    expect(JSON.stringify({ fenceToken: 7n, id: "a" }, adminJsonReplacer)).toBe(
      '{"fenceToken":"7","id":"a"}',
    );
  });
});

describe("TUI key handling", () => {
  it("switches views on the number keys and refreshes", () => {
    const state = createTuiState("workhorse_dev", null);
    for (const [index, view] of TUI_VIEW_ORDER.entries()) {
      expect(handleTuiKey(state, String(index + 1))).toBe("refresh");
      expect(state.view).toBe(view);
    }
  });

  it("quits on q and refreshes on r", () => {
    const state = createTuiState("workhorse_dev", null);
    expect(handleTuiKey(state, "q")).toBe("quit");
    expect(handleTuiKey(state, "ctrl-c")).toBe("quit");
    expect(handleTuiKey(state, "r")).toBe("refresh");
  });

  it("keeps the queue selection inside the loaded rows", () => {
    const state = createTuiState("workhorse_dev", null);
    state.queues = [queueStatus(), queueStatus({ queue: "mail" })];
    expect(handleTuiKey(state, "up")).toBe("render");
    expect(state.selectedQueue).toBe(0);
    handleTuiKey(state, "down");
    handleTuiKey(state, "down");
    expect(state.selectedQueue).toBe(1);
  });

  it("refuses pause without a confirmed environment", () => {
    const state = createTuiState("workhorse_dev", null);
    state.queues = [queueStatus()];
    expect(handleTuiKey(state, "p")).toBe("render");
    expect(state.pendingAction).toBeNull();
    expect(state.message).toContain("Read-only session");
  });

  it("stages a pause behind an explicit confirmation and cancels on any other key", () => {
    const state = createTuiState("workhorse_dev", { database: "workhorse_dev" });
    state.queues = [queueStatus()];
    expect(handleTuiKey(state, "p")).toBe("render");
    expect(state.pendingAction).toEqual({ kind: "pause", queue: "default" });
    expect(handleTuiKey(state, "n")).toBe("render");
    expect(state.pendingAction).toBeNull();
    handleTuiKey(state, "p");
    expect(handleTuiKey(state, "y")).toBe("confirm");
  });

  it("stages resume instead of pause for an already paused queue", () => {
    const state = createTuiState("workhorse_dev", { database: "workhorse_dev" });
    state.queues = [queueStatus({ paused: true })];
    handleTuiKey(state, "p");
    expect(state.pendingAction).toEqual({ kind: "resume", queue: "default" });
  });
});

describe("TUI frame rendering", () => {
  it("renders the queues view with the selection marker and read-only footer", () => {
    const state = createTuiState("workhorse_dev", null);
    state.queues = [queueStatus(), queueStatus({ queue: "mail" })];
    state.selectedQueue = 1;
    const frame = renderTuiFrame(state, 160, 40);
    expect(frame).toContain("workhorse tui — workhorse_dev (read-only) — queues");
    expect(frame).toContain(">  mail");
    expect(frame).toContain("relaunch with --env");
  });

  it("shows the staged action prompt in the footer", () => {
    const state = createTuiState("workhorse_dev", { database: "workhorse_dev" });
    state.queues = [queueStatus()];
    handleTuiKey(state, "p");
    const frame = renderTuiFrame(state);
    expect(frame).toContain('pause queue "default"? y to confirm');
  });

  it("clips every line to the terminal width", () => {
    const state = createTuiState("workhorse_dev", null);
    state.queues = [queueStatus({ queue: "a-very-long-queue-name" })];
    const frame = renderTuiFrame(state, 20, 40);
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(20);
  });
});
