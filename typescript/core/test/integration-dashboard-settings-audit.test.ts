import type { PoolClient, QueryResultRow } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Queue } from "../src/index.js";
import { SQL_STATEMENTS } from "../src/queue/sql-catalogue.generated.js";
import { createDatabaseTestHarness } from "./support/db.js";

// The audit of the four dashboard settings mutations (SM-1996). Each policy table holds one row,
// so each test runs in its own transaction on one client and rolls it back.
const database = createDatabaseTestHarness(import.meta.url, { max: 2 });
let client: PoolClient;

type Entry = Record<string, unknown>;
type Audit = Record<string, Entry> | null;

async function rows<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await client.query<T>(text, values)).rows;
}

async function audit(table: "retention_policy" | "maintenance_policy"): Promise<Audit> {
  const [row] = await rows<{ audit: Audit }>(
    `SELECT operator_audit AS audit FROM workhorse.${table} WHERE singleton`,
  );
  return row!.audit;
}

interface Provenance {
  source: "application" | "operator";
  lastChange: Entry | null;
}

/** The source of one setting, from `provenance`, and its entry under `lastChanges`, or null. */
async function provenance(
  policy: "retention" | "maintenance",
  setting: string,
): Promise<Provenance> {
  const [row] = await rows<{
    provenance: { source: Provenance["source"]; applicationDefault: unknown };
    change: Entry | null;
  }>(
    `SELECT document->$1::text->'provenance'->$2::text AS provenance,
            document->$1::text->'lastChanges'->$2::text AS change
       FROM workhorse.dashboard_settings_v1('{}'::jsonb) document`,
    [policy, setting],
  );
  // The provenance entry keeps its released shape.
  expect(Object.keys(row!.provenance).toSorted()).toEqual(["applicationDefault", "source"]);
  return { source: row!.provenance.source, lastChange: row!.change };
}

async function overrideRetention(overrides: object, actor: string, reason: string, id: string) {
  await rows(
    "SELECT (policy).* FROM workhorse.override_retention_policy_v2($1::jsonb, $2, $3, $4) policy",
    [JSON.stringify(overrides), actor, reason, id],
  );
}

beforeAll(async () => database.setup());
afterAll(async () => database.teardown());
beforeEach(async () => {
  client = await database.pool.connect();
  await client.query("BEGIN");
});
afterEach(async () => {
  await client.query("ROLLBACK");
  client.release();
});

describe("policy audit entries", () => {
  it("records an entry for each overridden retention setting and shows it as provenance", async () => {
    await overrideRetention(
      { task_event_retention_days: 1, terminal_task_prune_limit: 5 },
      "alice",
      "shrink history before the audit",
      "request-0123456789",
    );

    const entries = await audit("retention_policy");
    expect(Object.keys(entries!).toSorted()).toEqual([
      "task_event_retention_days",
      "terminal_task_prune_limit",
    ]);
    const [updated] = await rows<{ updated: string }>(
      `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated
         FROM workhorse.retention_policy`,
    );
    expect(entries!.task_event_retention_days).toEqual({
      action: "override",
      actor: "alice",
      reason: "shrink history before the audit",
      requestIdPreview: "request-…6789",
      requestIdDigest: expect.stringMatching(/^[0-9a-f]{12}$/),
      requestIdLength: 18,
      changedAt: updated!.updated,
    });
    // The raw request id is never stored, as in queue_control.
    expect(JSON.stringify(entries)).not.toContain("request-0123456789");

    const shown = await provenance("retention", "taskEventRetentionDays");
    expect(shown).toMatchObject({
      source: "operator",
      lastChange: {
        action: "override",
        actor: "alice",
        reason: "shrink history before the audit",
        requestIdPreview: "request-…6789",
        requestIdLength: 18,
      },
    });
    expect(shown.lastChange!.changedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect((await provenance("retention", "attemptHistoryRetentionDays")).lastChange).toBeNull();
  });

  it("keeps the entry of a revert so that settings shows who removed the override", async () => {
    await overrideRetention({ task_event_retention_days: 1 }, "alice", "shrink", "r-1");
    await rows(
      "SELECT (policy).* FROM workhorse.revert_retention_policy_v2($1::text[], $2, $3, $4) policy",
      [["task_event_retention_days"], "bob", "restore the default", "r-2"],
    );

    expect((await audit("retention_policy"))!.task_event_retention_days).toMatchObject({
      action: "revert",
      actor: "bob",
      reason: "restore the default",
    });
    expect(await provenance("retention", "taskEventRetentionDays")).toMatchObject({
      source: "application",
      lastChange: { action: "revert", actor: "bob", reason: "restore the default" },
    });
  });

  it("records the maintenance override and revert of each changed setting only", async () => {
    await rows(
      `SELECT (policy).* FROM workhorse.override_maintenance_policy_v2(
         $1, NULL, NULL, $2::time, NULL, NULL, NULL, $3, $4, $5) policy`,
      ["Europe/Berlin", "04:30", "carol", "move the retention pass", "r-3"],
    );
    expect(Object.keys((await audit("maintenance_policy"))!).toSorted()).toEqual([
      "history_retention_local_time",
      "timezone",
    ]);
    expect(await provenance("maintenance", "timezone")).toMatchObject({
      source: "operator",
      lastChange: { action: "override", actor: "carol", reason: "move the retention pass" },
    });

    await rows(
      "SELECT (policy).* FROM workhorse.revert_maintenance_policy_v2($1::text[], $2, $3, $4) policy",
      [["timezone"], "dave", "back to UTC", "r-4"],
    );
    const entries = await audit("maintenance_policy");
    expect(entries!.timezone).toMatchObject({ action: "revert", actor: "dave" });
    expect(entries!.history_retention_local_time).toMatchObject({
      action: "override",
      actor: "carol",
    });
  });

  it("removes the entries of the settings that a v1 override or revert changes", async () => {
    await overrideRetention(
      { task_event_retention_days: 1, attempt_history_retention_days: 2 },
      "alice",
      "shrink",
      "r-1",
    );
    // Queue.overrideRetentionPolicy calls v1 with no audit. The value is no longer alice's.
    await rows("SELECT (policy).* FROM workhorse.override_retention_policy_v1($1::jsonb) policy", [
      JSON.stringify({ task_event_retention_days: 3 }),
    ]);
    expect(Object.keys((await audit("retention_policy"))!)).toEqual([
      "attempt_history_retention_days",
    ]);
    expect((await provenance("retention", "taskEventRetentionDays")).lastChange).toBeNull();

    await rows("SELECT (policy).* FROM workhorse.revert_retention_policy_v1($1::text[]) policy", [
      ["attempt_history_retention_days"],
    ]);
    expect(await audit("retention_policy")).toBeNull();

    await rows(
      `SELECT (policy).* FROM workhorse.override_maintenance_policy_v2(
         $1, NULL, NULL, NULL, NULL, $2, NULL, 'carol', 'tune', 'r-5') policy`,
      ["Europe/Berlin", 300],
    );
    await rows(
      `SELECT (policy).* FROM workhorse.override_maintenance_policy_v1(
         NULL, NULL, NULL, NULL, NULL, $1, NULL) policy`,
      [400],
    );
    expect(Object.keys((await audit("maintenance_policy"))!)).toEqual(["timezone"]);
    await rows("SELECT (policy).* FROM workhorse.revert_maintenance_policy_v1($1::text[]) policy", [
      ["timezone"],
    ]);
    expect(await audit("maintenance_policy")).toBeNull();
  });

  it("keeps an entry on a sync without force only while the sync keeps its value", async () => {
    await overrideRetention({ task_event_retention_days: 1 }, "alice", "shrink", "r-1");
    await rows(
      "SELECT (policy).* FROM workhorse.revert_retention_policy_v2($1::text[], 'bob', 'default', 'r-2') policy",
      [["attempt_history_retention_days", "statistics_retention_days"]],
    );
    await rows(
      `SELECT (policy).* FROM workhorse.override_maintenance_policy_v2(
         'Europe/Berlin', NULL, NULL, NULL, NULL, NULL, NULL, 'carol', 'tz', 'r-3') policy`,
    );
    await rows(
      "SELECT (policy).* FROM workhorse.revert_maintenance_policy_v2($1::text[], 'dave', 'default', 'r-4') policy",
      [["history_retention_local_time"]],
    );

    // The sync changes the application value of attempt history and of the retention time, and it
    // keeps the statistics window. It does not change an operator value.
    await rows(
      `SELECT (policy).* FROM workhorse.sync_retention_policy_v1(
         20, 20, 20, 20, 20, 14, NULL, NULL, NULL, NULL, NULL, false) policy`,
    );
    await rows(
      `SELECT (policy).* FROM workhorse.sync_maintenance_policy_v1(
         'UTC', NULL, NULL, '04:00', NULL, NULL, NULL, false) policy`,
    );
    expect(Object.keys((await audit("retention_policy"))!).toSorted()).toEqual([
      "statistics_retention_days",
      "task_event_retention_days",
    ]);
    expect(await provenance("retention", "taskEventRetentionDays")).toMatchObject({
      source: "operator",
      lastChange: { actor: "alice" },
    });
    // Bob reverted attempt history to 14 days. The sync changed it to 20 days.
    expect(await provenance("retention", "attemptHistoryRetentionDays")).toEqual({
      source: "application",
      lastChange: null,
    });
    expect(await provenance("retention", "statisticsRetentionDays")).toMatchObject({
      source: "application",
      lastChange: { actor: "bob" },
    });
    expect(Object.keys((await audit("maintenance_policy"))!)).toEqual(["timezone"]);
    expect((await provenance("maintenance", "timezone")).lastChange).toMatchObject({
      actor: "carol",
    });

    // A sync that changes no value keeps each entry.
    await rows(
      `SELECT (policy).* FROM workhorse.sync_retention_policy_v1(
         20, 20, 20, 20, 20, 14, NULL, NULL, NULL, NULL, NULL, false) policy`,
    );
    expect(Object.keys((await audit("retention_policy"))!)).toHaveLength(2);

    // A forced sync puts each application value back and removes the operator ownership.
    await rows(
      `SELECT (policy).* FROM workhorse.sync_retention_policy_v1(
         20, 20, 20, 20, 20, 20, NULL, NULL, NULL, NULL, NULL, true) policy`,
    );
    await rows(
      `SELECT (policy).* FROM workhorse.sync_maintenance_policy_v1(
         'UTC', NULL, NULL, NULL, NULL, NULL, NULL, true) policy`,
    );
    expect(await audit("retention_policy")).toBeNull();
    expect(await audit("maintenance_policy")).toBeNull();
  });

  it("treats a null force as no force when a sync changes a reverted value", async () => {
    await rows(
      "SELECT (policy).* FROM workhorse.revert_maintenance_policy_v2($1::text[], 'dave', 'default', 'r-5') policy",
      [["timezone"]],
    );
    await rows(
      `SELECT (policy).* FROM workhorse.sync_maintenance_policy_v1(
         'Europe/Berlin', NULL, NULL, NULL, NULL, NULL, NULL, NULL) policy`,
    );
    expect(await audit("maintenance_policy")).toBeNull();

    await rows(
      "SELECT (policy).* FROM workhorse.revert_retention_policy_v2($1::text[], 'dave', 'default', 'r-6') policy",
      [["attempt_history_retention_days"]],
    );
    await rows(
      `SELECT (policy).* FROM workhorse.sync_retention_policy_v1(
         20, 20, 20, 20, 20, 20, NULL, NULL, NULL, NULL, NULL, NULL) policy`,
    );
    expect(await audit("retention_policy")).toBeNull();
  });

  it("reads the time of a revert after the wait for the row lock", async () => {
    // The test client holds the policy row. A second connection starts the revert and waits.
    await client.query("SELECT 1 FROM workhorse.retention_policy WHERE singleton FOR UPDATE");
    let holdsLock = true;
    const releaseLock = async () => {
      if (!holdsLock) return;
      holdsLock = false;
      await client.query("ROLLBACK");
      await client.query("BEGIN");
    };
    const reverter = await database.pool.connect();
    let revert: Promise<{ rows: { changed_at: string }[] }> | undefined;
    try {
      const { rows: backend } = await reverter.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      let settled = false;
      revert = reverter.query<{ changed_at: string }>(
        `SELECT (policy).operator_audit->'task_event_retention_days'->>'changedAt' AS changed_at
           FROM workhorse.revert_retention_policy_v2(
             ARRAY['task_event_retention_days'], 'bob', 'default', 'r-lock') policy`,
      );
      revert.then(
        () => (settled = true),
        () => (settled = true),
      );
      // Wait until PostgreSQL reports the revert as blocked by this client. A revert that ends
      // without a wait, or a wait that does not come within the deadline, fails the test.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows: blocked } = await client.query<{ blocked: boolean }>(
          "SELECT pg_backend_pid() = ANY(pg_blocking_pids($1)) AS blocked",
          [backend[0]!.pid],
        );
        if (blocked[0]!.blocked) break;
        if (settled) throw new Error("the revert ended without waiting for the row lock");
        if (Date.now() > deadline) throw new Error("the revert did not wait for the row lock");
      }
      // The time while the revert still waits, as text, so no precision is lost.
      const { rows: observed } = await client.query<{ at: string }>(
        "SELECT clock_timestamp()::text AS at",
      );
      await releaseLock();
      const { rows: changed } = await revert;
      const { rows: order } = await client.query<{ after: boolean }>(
        "SELECT $1::timestamptz > $2::timestamptz AS after",
        [changed[0]!.changed_at, observed[0]!.at],
      );
      expect(order[0]!.after).toBe(true);
    } finally {
      // Release the row first, so the revert can end, then put the row back for the next test.
      await releaseLock();
      await revert?.catch(() => undefined);
      await reverter.query(
        `SELECT workhorse.sync_retention_policy_v1(
           14, 14, 14, 14, 14, 14, 1000, 4, 10000, 10000, 10000, true)`,
      );
      reverter.release();
    }
  });

  it("shows no entry whose action does not match the source of the setting", async () => {
    // A direct write can leave an entry behind that no longer describes the value.
    await client.query(`UPDATE workhorse.retention_policy SET operator_audit = jsonb_build_object(
      'task_event_retention_days', jsonb_build_object(
        'action', 'override', 'actor', 'stale', 'reason', 'stale', 'requestIdPreview', '••',
        'requestIdDigest', '000000000000', 'requestIdLength', 2,
        'changedAt', '2026-01-01T00:00:00.000000Z'))`);
    expect(await provenance("retention", "taskEventRetentionDays")).toMatchObject({
      source: "application",
      lastChange: null,
    });
  });

  it.each([
    ["an empty actor", "", "reason", "r", /requested_by must contain between 1 and 200/],
    ["an actor of 201 characters", "a".repeat(201), "r", "r", /between 1 and 200 characters/],
    ["a reason of 2001 characters", "a", "r".repeat(2001), "r", /between 1 and 2000 characters/],
    ["a request id of 513 bytes", "a", "r", "é".repeat(256) + "x", /1 and 512 UTF-8 bytes/],
    ["no request id", "a", "r", null, /request_id must contain/],
  ])("refuses %s before it changes a value", async (_name, actor, reason, id, message) => {
    await client.query("SAVEPOINT refused");
    await expect(
      client.query(
        "SELECT workhorse.override_retention_policy_v2('{\"task_event_retention_days\":1}', $1, $2, $3)",
        [actor, reason, id],
      ),
    ).rejects.toThrow(message);
    await client.query("ROLLBACK TO SAVEPOINT refused");
    for (const call of [
      "SELECT workhorse.revert_retention_policy_v2(ARRAY['task_event_retention_days'], $1, $2, $3)",
      "SELECT workhorse.override_maintenance_policy_v2('UTC', NULL, NULL, NULL, NULL, NULL, NULL, $1, $2, $3)",
      "SELECT workhorse.revert_maintenance_policy_v2(ARRAY['timezone'], $1, $2, $3)",
    ]) {
      await expect(client.query(call, [actor, reason, id])).rejects.toThrow(message);
      await client.query("ROLLBACK TO SAVEPOINT refused");
    }
    const [policy] = await rows<{ days: number; audit: Audit }>(
      "SELECT task_event_retention_days AS days, operator_audit AS audit FROM workhorse.retention_policy",
    );
    expect(policy).toEqual({ days: 14, audit: null });
  });

  it("accepts the limits themselves", async () => {
    await overrideRetention(
      { task_event_retention_days: 1 },
      "a".repeat(200),
      "r".repeat(2000),
      "é".repeat(256),
    );
    expect((await audit("retention_policy"))!.task_event_retention_days).toMatchObject({
      requestIdLength: 256,
    });
  });
});

/** A Queue on the test client that records each statement that it sends. */
function recordingQueue(): { queue: Queue; statements: string[] } {
  const statements: string[] = [];
  const queue = new Queue({
    query: (text: string, values?: readonly unknown[]) => {
      statements.push(text);
      return client.query(text, values as unknown[]);
    },
  } as PoolClient);
  return { queue, statements };
}

// SM-2030: a TypeScript application stores the audit of a policy change through Queue, with no SQL
// of its own. Before this option, Queue called only the _v1 functions, which store no audit.
describe("Queue policy changes", () => {
  it("stores the actor and the reason of each change under lastChanges", async () => {
    const { queue, statements } = recordingQueue();
    const retention = await queue.overrideRetentionPolicy(
      { taskEventRetentionDays: 1, terminalTaskPruneLimit: 5 },
      { audit: { actor: "alice", reason: "shrink history", requestId: "request-0123456789" } },
    );
    expect(retention.taskEventRetentionDays).toBe(1);
    expect(await provenance("retention", "taskEventRetentionDays")).toMatchObject({
      source: "operator",
      lastChange: {
        action: "override",
        actor: "alice",
        reason: "shrink history",
        requestIdPreview: "request-…6789",
      },
    });
    expect((await provenance("retention", "terminalTaskPruneLimit")).lastChange).toMatchObject({
      actor: "alice",
    });

    await queue.revertRetentionPolicy(["terminalTaskPruneLimit"], {
      audit: { actor: "bob", reason: "restore the limit", requestId: "r-2" },
    });
    expect(await provenance("retention", "terminalTaskPruneLimit")).toMatchObject({
      source: "application",
      lastChange: { action: "revert", actor: "bob", reason: "restore the limit" },
    });

    const maintenance = await queue.overrideMaintenancePolicy(
      { timezone: "Europe/Berlin", historyRetentionLocalTime: "04:30" },
      { audit: { actor: "carol", reason: "move the retention pass", requestId: "r-3" } },
    );
    expect(maintenance.timezone).toBe("Europe/Berlin");
    expect(await provenance("maintenance", "historyRetentionLocalTime")).toMatchObject({
      source: "operator",
      lastChange: { action: "override", actor: "carol", reason: "move the retention pass" },
    });

    await queue.revertMaintenancePolicy(["timezone"], {
      audit: { actor: "dave", reason: "back to UTC", requestId: "r-4" },
    });
    expect(await provenance("maintenance", "timezone")).toMatchObject({
      source: "application",
      lastChange: { action: "revert", actor: "dave", reason: "back to UTC" },
    });
    // The raw request ID is never stored.
    expect(JSON.stringify(await audit("retention_policy"))).not.toContain("request-0123456789");
    expect(statements.filter((text) => text.includes("_policy_v"))).toEqual([
      SQL_STATEMENTS["override_retention_policy_v2"],
      SQL_STATEMENTS["revert_retention_policy_v2"],
      SQL_STATEMENTS["override_maintenance_policy_v2"],
      SQL_STATEMENTS["revert_maintenance_policy_v2"],
    ]);
  });

  it("calls the released functions without an audit and removes each changed entry", async () => {
    const { queue, statements } = recordingQueue();
    await overrideRetention(
      { task_event_retention_days: 1, attempt_history_retention_days: 2 },
      "alice",
      "shrink",
      "r-1",
    );
    await rows(
      `SELECT (policy).* FROM workhorse.override_maintenance_policy_v2(
         'Europe/Berlin', NULL, NULL, '04:30'::time, NULL, NULL, NULL, 'carol', 'tune', 'r-2') policy`,
    );

    const retention = await queue.overrideRetentionPolicy({ taskEventRetentionDays: 3 });
    expect(retention).toMatchObject({
      taskEventRetentionDays: 3,
      provenance: {
        taskEventRetentionDays: { source: "operator" },
        attemptHistoryRetentionDays: { source: "operator" },
      },
    });
    expect(Object.keys((await audit("retention_policy"))!)).toEqual([
      "attempt_history_retention_days",
    ]);
    await queue.revertRetentionPolicy(["attemptHistoryRetentionDays"]);
    expect(await audit("retention_policy")).toBeNull();

    await queue.overrideMaintenancePolicy({ historyRetentionLocalTime: "05:00" });
    expect(Object.keys((await audit("maintenance_policy"))!)).toEqual(["timezone"]);
    await queue.revertMaintenancePolicy(["timezone"]);
    expect(await audit("maintenance_policy")).toBeNull();
    expect((await provenance("maintenance", "timezone")).lastChange).toBeNull();
    expect(statements.filter((text) => text.includes("_policy_v"))).toEqual([
      SQL_STATEMENTS["override_retention_policy_v1"],
      SQL_STATEMENTS["revert_retention_policy_v1"],
      SQL_STATEMENTS["override_maintenance_policy_v1"],
      SQL_STATEMENTS["revert_maintenance_policy_v1"],
    ]);
  });
});

describe("released policy functions", () => {
  // The released column list of each policy row. The functions that return a row add only the
  // new column, at its end.
  const retentionColumns = [
    "singleton",
    "task_identity_retention_days",
    "terminal_outcome_retention_days",
    "task_event_retention_days",
    "attempt_history_retention_days",
    "schedule_occurrence_retention_days",
    "statistics_retention_days",
    "terminal_task_prune_limit",
    "history_partitions_per_pass",
    "default_partition_rows_per_pass",
    "occurrence_rows_per_pass",
    "statistics_rows_per_pass",
    "application_task_identity_retention_days",
    "application_terminal_outcome_retention_days",
    "application_task_event_retention_days",
    "application_attempt_history_retention_days",
    "application_schedule_occurrence_retention_days",
    "application_statistics_retention_days",
    "application_terminal_task_prune_limit",
    "application_history_partitions_per_pass",
    "application_default_partition_rows_per_pass",
    "application_occurrence_rows_per_pass",
    "application_statistics_rows_per_pass",
    "operator_overrides",
    "updated_at",
  ];
  const maintenanceColumns = [
    "singleton",
    "timezone",
    "partition_preparation_interval_ms",
    "terminal_cleanup_interval_ms",
    "history_retention_local_time",
    "application_timezone",
    "application_partition_preparation_interval_ms",
    "application_terminal_cleanup_interval_ms",
    "application_history_retention_local_time",
    "operator_overrides",
    "updated_at",
    "statistics_rollup_interval_ms",
    "statistics_group_limit",
    "statistics_recompute_buckets",
    "application_statistics_rollup_interval_ms",
    "application_statistics_group_limit",
    "application_statistics_recompute_buckets",
  ];

  it.each([
    [
      "override_retention_policy_v1",
      "SELECT (policy).* FROM workhorse.override_retention_policy_v1('{\"task_event_retention_days\":3}') policy",
      retentionColumns,
      { task_event_retention_days: 3, operator_overrides: ["task_event_retention_days"] },
    ],
    [
      "revert_retention_policy_v1",
      "SELECT (policy).* FROM workhorse.revert_retention_policy_v1(ARRAY['task_event_retention_days']) policy",
      retentionColumns,
      { task_event_retention_days: 14, operator_overrides: [] },
    ],
    [
      "sync_retention_policy_v1",
      "SELECT (policy).* FROM workhorse.sync_retention_policy_v1(9, 9, 9, 9, 9, 9, NULL, NULL, NULL, NULL, NULL, false) policy",
      retentionColumns,
      { task_event_retention_days: 9, application_task_event_retention_days: 9 },
    ],
    [
      "get_retention_policy_v1",
      "SELECT (policy).* FROM workhorse.get_retention_policy_v1() policy",
      retentionColumns,
      { task_event_retention_days: 14, operator_overrides: [] },
    ],
    [
      "override_maintenance_policy_v1",
      "SELECT (policy).* FROM workhorse.override_maintenance_policy_v1('Europe/Berlin') policy",
      maintenanceColumns,
      { timezone: "Europe/Berlin", operator_overrides: ["timezone"] },
    ],
    [
      "revert_maintenance_policy_v1",
      "SELECT (policy).* FROM workhorse.revert_maintenance_policy_v1(ARRAY['timezone']) policy",
      maintenanceColumns,
      { timezone: "UTC", operator_overrides: [] },
    ],
    [
      "sync_maintenance_policy_v1",
      "SELECT (policy).* FROM workhorse.sync_maintenance_policy_v1('Asia/Tokyo') policy",
      maintenanceColumns,
      { timezone: "Asia/Tokyo", application_timezone: "Asia/Tokyo" },
    ],
    [
      "get_maintenance_policy_v1",
      "SELECT (policy).* FROM workhorse.get_maintenance_policy_v1() policy",
      maintenanceColumns,
      { timezone: "UTC", operator_overrides: [] },
    ],
  ])(
    "%s returns its released row with the new column at its end",
    async (_name, sql, columns, values) => {
      const result = await client.query(sql);
      expect(result.fields.map((field) => field.name)).toEqual([...columns, "operator_audit"]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ ...values, operator_audit: null });
    },
  );
});
