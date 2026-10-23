import { describe, expect, it } from "vitest";
import { Queue } from "../src/index.js";
import { SQL_STATEMENTS } from "../src/queue/sql-catalogue.generated.js";

const recordingQueue = () => {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const queue = new Queue({
    query: async (text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
    },
  });
  return { calls, queue };
};

describe("maintenance time", () => {
  it("binds the text 'now' so PostgreSQL chooses the time of each maintenance call", async () => {
    const { calls, queue } = recordingQueue();

    await queue.runMaintenance();
    await queue.prepareHistoryPartitions();
    await queue.rollupStatistics();
    await queue.retainHistory();
    await queue.pruneTerminalStorage();

    expect(calls.map(({ text, values }) => [text, values])).toEqual([
      [SQL_STATEMENTS["run_maintenance_v1"], ["now"]],
      [SQL_STATEMENTS["prepare_history_partitions_v1"], [false, "now"]],
      [SQL_STATEMENTS["rollup_stats_v1"], [false, "now", 240]],
      [SQL_STATEMENTS["retain_history_v1"], [false, "now"]],
      [SQL_STATEMENTS["prune_terminal_storage_v1"], [false, "now"]],
    ]);
  });

  it("keeps an explicit time for tests and operator repairs", async () => {
    const { calls, queue } = recordingQueue();
    const now = new Date("2026-08-02T12:00:00.000Z");

    await queue.runMaintenance({ now });
    await queue.retainHistory({ force: true, now });

    expect(calls.map(({ values }) => values)).toEqual([[now], [true, now]]);
  });
});
