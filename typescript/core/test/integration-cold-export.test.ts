import { describe, expect, it } from "vitest";
import { createIntegrationTestContext } from "./support/integration.js";

const { defaultRetentionPolicy, pool, queue } = createIntegrationTestContext(import.meta.url);

type Dataset = "task_event" | "attempt_history";

function utcDay(daysAgo: number): Date {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - daysAgo);
  return day;
}

/** Run `count` tasks to completion and move their history into the hour after `day` began. */
async function seedHistory(type: string, count: number, day: Date): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = await queue.enqueue(type, { index });
    const claimed = await queue.claim(`${type}-worker`);
    expect(claimed?.id).toBe(id);
    await queue.complete(claimed!, `${type}-worker`, { index });
    ids.push(id);
  }
  for (const relation of ["task_event", "attempt_history"]) {
    await pool.query(
      `UPDATE workhorse.${relation}
          SET occurred_at = $1::timestamptz + interval '1 hour'
            + (occurred_at - date_trunc('hour', occurred_at))
        WHERE task_id = ANY($2::uuid[])`,
      [day, ids],
    );
  }
  return ids;
}

async function historyIds(dataset: Dataset, day: Date): Promise<string[]> {
  const column = dataset === "task_event" ? "event_id" : "attempt_id";
  const result = await pool.query<{ id: string }>(
    `SELECT ${column} AS id FROM workhorse.${dataset}
      WHERE occurred_at >= $1 AND occurred_at < $1::timestamptz + interval '1 day'
      ORDER BY occurred_at, ${column}`,
    [day],
  );
  return result.rows.map((row) => row.id);
}

async function countRows(relation: string): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*) FROM workhorse.${relation}`);
  return Number(result.rows[0]!.count);
}

type Claim = { segment_start: Date; segment_end: Date; attempts: number };

async function claimSegment(dataset: Dataset, exporterId = "test"): Promise<Claim | null> {
  const result = await pool.query<Claim>(
    "SELECT * FROM workhorse.claim_cold_export_segment_v1($1, $2, $3, clock_timestamp())",
    [dataset, exporterId, 60_000],
  );
  return result.rows[0] ?? null;
}

/**
 * The exporter contract from ADR 0068, driven directly: claim a day, read it in keyset pages,
 * complete it. Returns the row identities in export order.
 */
async function exportNextDay(
  dataset: Dataset,
  pageSize = 2,
): Promise<{ claim: Claim; ids: string[]; exportedThrough: Date } | null> {
  const claim = await claimSegment(dataset);
  if (claim === null) return null;
  type PageRow = { row_id: string; record: { occurred_at: string } };
  const ids: string[] = [];
  let cursor: { occurred_at: string; row_id: string } | null = null;
  for (;;) {
    const page: { rows: PageRow[] } = await pool.query<PageRow>(
      "SELECT * FROM workhorse.read_cold_export_rows_v1($1, $2, $3, $4, $5, $6)",
      [
        dataset,
        claim.segment_start,
        claim.segment_end,
        cursor?.occurred_at ?? null,
        cursor?.row_id ?? null,
        pageSize,
      ],
    );
    for (const row of page.rows) ids.push(row.row_id);
    const last: PageRow | undefined = page.rows[page.rows.length - 1];
    if (last === undefined || page.rows.length < pageSize) break;
    cursor = { occurred_at: last.record.occurred_at, row_id: last.row_id };
  }
  const key = ids.length === 0 ? null : `workhorse/${dataset}/${claim.segment_start.toISOString()}`;
  const completed = await pool.query<{ exported_through: Date }>(
    `SELECT workhorse.complete_cold_export_segment_v1($1, $2, $3, $4, $5, $6, $7, $8)
       AS exported_through`,
    [
      dataset,
      claim.segment_start,
      claim.attempts,
      key,
      `${key ?? "workhorse/empty"}.manifest.json`,
      ids.length === 0 ? null : "0".repeat(64),
      ids.length * 100,
      ids.length,
    ],
  );
  return { claim, ids, exportedThrough: completed.rows[0]!.exported_through };
}

describe("cold history export", () => {
  it("reports export as off by default and leaves retention unclamped", async () => {
    await expect(queue.getColdExportStatus()).resolves.toMatchObject({
      enabled: false,
      datasets: {
        task_event: { exportedThrough: null, completeSegments: 0, exporting: null },
        attempt_history: { exportedThrough: null, completeSegments: 0, exporting: null },
      },
    });

    await seedHistory("cold-export-off", 2, utcDay(10));
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
    });
    await queue.retainHistory({ force: true });
    expect(await countRows("task_event")).toBe(0);
    expect(await countRows("attempt_history")).toBe(0);

    // Nothing is handed out while export is off.
    expect(await claimSegment("task_event")).toBeNull();
  });

  it("hands out each finalized day in order, pages it by identity, and advances the watermark", async () => {
    await seedHistory("cold-export-older", 3, utcDay(2));
    await seedHistory("cold-export-newer", 2, utcDay(1));
    // Today's rows stay: the day is open and no exporter may take it yet.
    await seedHistory("cold-export-today", 1, utcDay(0));

    const enabled = await queue.setColdExportPolicy({ enabled: true });
    expect(enabled.enabled).toBe(true);
    expect(enabled.datasets.task_event.exportedThrough).toEqual(utcDay(2));
    expect(enabled.datasets.attempt_history.exportedThrough).toEqual(utcDay(2));
    expect(enabled.datasets.task_event.exportableThrough).toEqual(utcDay(0));

    for (const dataset of ["task_event", "attempt_history"] as const) {
      for (const day of [utcDay(2), utcDay(1)]) {
        const exported = await exportNextDay(dataset);
        expect(exported?.claim).toMatchObject({ segment_start: day, attempts: 1 });
        expect(exported?.ids).toEqual(await historyIds(dataset, day));
        expect(exported?.ids.length).toBeGreaterThan(0);
      }
      expect((await exportNextDay(dataset))?.exportedThrough).toBeUndefined();
    }

    const status = await queue.getColdExportStatus();
    expect(status.datasets.task_event).toMatchObject({
      exportedThrough: utcDay(0),
      completeSegments: 2,
      exporting: null,
      lastError: null,
    });
    expect(status.datasets.attempt_history.exportedThrough).toEqual(utcDay(0));
    expect(await countRows("cold_export_segment")).toBe(4);
  });

  it("holds history retention at the export watermark and releases it once the day is exported", async () => {
    await seedHistory("cold-export-held", 2, utcDay(3));
    const events = await countRows("task_event");
    const attempts = await countRows("attempt_history");

    await queue.setColdExportPolicy({ enabled: true });
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
    });
    await queue.retainHistory({ force: true });
    expect(await countRows("task_event")).toBe(events);
    expect(await countRows("attempt_history")).toBe(attempts);

    // Three days per dataset: the seeded day and two empty ones, which complete without an object.
    for (const dataset of ["task_event", "attempt_history"] as const) {
      const days = [];
      for (
        let exported = await exportNextDay(dataset);
        exported;
        exported = await exportNextDay(dataset)
      ) {
        days.push(exported.ids.length);
      }
      expect(days).toEqual([expect.any(Number), 0, 0]);
      expect(days[0]).toBeGreaterThan(0);
    }
    const empty = await pool.query<{ object_key: string | null; row_count: string }>(
      "SELECT object_key, row_count FROM workhorse.cold_export_segment WHERE row_count = 0",
    );
    expect(empty.rows).toHaveLength(4);
    expect(empty.rows.every((row) => row.object_key === null)).toBe(true);

    await queue.retainHistory({ force: true });
    expect(await countRows("task_event")).toBe(0);
    expect(await countRows("attempt_history")).toBe(0);
  });

  it("re-leases a failed segment, and fences a stale completion or failure", async () => {
    await seedHistory("cold-export-retry", 2, utcDay(1));
    await queue.setColdExportPolicy({ enabled: true, from: utcDay(1) });

    const first = await claimSegment("task_event", "exporter-a");
    expect(first).toMatchObject({ segment_start: utcDay(1), attempts: 1 });
    // A live lease blocks a second exporter.
    expect(await claimSegment("task_event", "exporter-b")).toBeNull();

    await pool.query("SELECT workhorse.fail_cold_export_segment_v1($1, $2, $3, $4::jsonb)", [
      "task_event",
      utcDay(1),
      1,
      JSON.stringify({ name: "Error", message: "bucket unavailable" }),
    ]);
    await expect(queue.getColdExportStatus()).resolves.toMatchObject({
      datasets: {
        task_event: {
          exportedThrough: utcDay(1),
          exporting: { segmentStart: utcDay(1), attempts: 1 },
          lastError: { name: "Error", message: "bucket unavailable" },
        },
      },
    });

    const second = await claimSegment("task_event", "exporter-b");
    expect(second).toMatchObject({ segment_start: utcDay(1), attempts: 2 });

    await expect(
      pool.query(
        "SELECT workhorse.complete_cold_export_segment_v1($1, $2, $3, NULL, 'stale', NULL, 0, 0)",
        ["task_event", utcDay(1), 1],
      ),
    ).rejects.toThrow(/not held by attempt 1/);
    await expect(
      pool.query("SELECT workhorse.fail_cold_export_segment_v1($1, $2, $3, '{}'::jsonb)", [
        "task_event",
        utcDay(1),
        1,
      ]),
    ).rejects.toThrow(/not held by attempt 1/);

    await pool.query(
      "SELECT workhorse.complete_cold_export_segment_v1($1, $2, $3, 'k', 'k.manifest.json', $4, 1, 1)",
      ["task_event", utcDay(1), 2, "a".repeat(64)],
    );
    await expect(queue.getColdExportStatus()).resolves.toMatchObject({
      datasets: { task_event: { exportedThrough: utcDay(0), exporting: null, lastError: null } },
    });
  });

  it("starts where the operator says, never moves a started export, and skips days deleted while off", async () => {
    await seedHistory("cold-export-start", 1, utcDay(4));
    const started = await queue.setColdExportPolicy({ enabled: true, from: utcDay(2) });
    expect(started.datasets.task_event.exportedThrough).toEqual(utcDay(2));
    await expect(queue.setColdExportPolicy({ enabled: true, from: utcDay(3) })).rejects.toThrow(
      /already started/,
    );
    await expect(queue.setColdExportPolicy({ enabled: false, from: utcDay(3) })).rejects.toThrow(
      /applies only when enabling/,
    );

    const off = await queue.setColdExportPolicy({ enabled: false });
    expect(off.enabled).toBe(false);
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
    });
    await queue.retainHistory({ force: true });
    expect(await countRows("task_event")).toBe(0);

    // The rows below the watermark are gone, so re-enabling cannot export them and says so by
    // moving the watermark to the oldest retained day, which is now today.
    const again = await queue.setColdExportPolicy({ enabled: true });
    expect(again.datasets.task_event.exportedThrough).toEqual(utcDay(0));
    expect(await claimSegment("task_event")).toBeNull();
  });
});
