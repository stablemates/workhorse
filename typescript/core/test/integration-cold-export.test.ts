import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Worker } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { admin, adminAudit, defaultRetentionPolicy, pool, queue } = createIntegrationTestContext(
  import.meta.url,
);

type Dataset = "task_event" | "attempt_history" | "fast_task_outcome";

function pidOf(client: unknown): number {
  return (client as { processID: number }).processID;
}

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

  it.each([
    { timeZone: "America/New_York", spring: "2026-03-08", fall: "2025-11-02" },
    { timeZone: "Europe/Berlin", spring: "2026-03-29", fall: "2025-10-26" },
  ])(
    "hands out 24-hour UTC days across both daylight-saving transitions in $timeZone",
    async ({ timeZone, spring, fall }) => {
      const dayMs = 86_400_000;
      const client = await pool.connect();
      try {
        await client.query(`SET TimeZone = '${timeZone}'`);
        for (const transition of [spring, fall]) {
          // Each transition starts a fresh ledger the day before it, so the export crosses it.
          await client.query("DELETE FROM workhorse.cold_export_segment");
          await client.query("DELETE FROM workhorse.cold_export_dataset");
          const from = new Date(Date.parse(`${transition}T00:00:00Z`) - dayMs);
          await client.query("SELECT * FROM workhorse.set_cold_export_policy_v1(true, $1)", [from]);

          const segments: { start: number; end: number }[] = [];
          for (let index = 0; index < 3; index += 1) {
            const claimed = await client.query<Claim>(
              "SELECT * FROM workhorse.claim_cold_export_segment_v1($1, 'dst', 60000, clock_timestamp())",
              ["task_event"],
            );
            const claim = claimed.rows[0]!;
            segments.push({
              start: claim.segment_start.getTime(),
              end: claim.segment_end.getTime(),
            });
            await client.query(
              `SELECT workhorse.complete_cold_export_segment_v1(
                 'task_event', $1, $2, NULL, 'k.manifest.json', NULL, 0, 0)`,
              [claim.segment_start, claim.attempts],
            );
          }
          expect(segments).toEqual(
            [0, 1, 2].map((day) => ({
              start: from.getTime() + day * dayMs,
              end: from.getTime() + (day + 1) * dayMs,
            })),
          );
        }
      } finally {
        await client.query("RESET TimeZone");
        client.release();
      }
    },
  );

  it("refuses a ledger row off a UTC midnight or not exactly one day long", async () => {
    const midnight = utcDay(3);
    const insert = (start: Date, end: Date) =>
      pool.query(
        `INSERT INTO workhorse.cold_export_segment(dataset, segment_start, segment_end, status)
         VALUES ('task_event', $1, $2, 'exporting')`,
        [start, end],
      );
    await expect(
      insert(new Date(midnight.getTime() + 3_600_000), new Date(midnight.getTime() + 90_000_000)),
    ).rejects.toThrow(/cold_export_segment_utc_day_check/);
    await expect(insert(midnight, new Date(midnight.getTime() + 82_800_000))).rejects.toThrow(
      /cold_export_segment_utc_day_check/,
    );
    await expect(
      pool.query(
        "INSERT INTO workhorse.cold_export_dataset(dataset, exported_through) VALUES ('task_event', $1)",
        [new Date(midnight.getTime() + 3_600_000)],
      ),
    ).rejects.toThrow(/cold_export_dataset_utc_midnight_check/);
  });

  it("repairs a version-50 ledger that a daylight-saving session left off UTC midnight", async () => {
    const repair = await readFile(
      new URL(
        "../../../sql/migrations/0052-keep-cold-export-segments-one-utc-day.sql",
        import.meta.url,
      ),
      "utf8",
    );
    // Return to the version-50 checks, which accepted any finite range.
    await pool.query(`
      ALTER TABLE workhorse.cold_export_dataset
        DROP CONSTRAINT cold_export_dataset_utc_midnight_check;
      ALTER TABLE workhorse.cold_export_segment DROP CONSTRAINT cold_export_segment_utc_day_check;
      DELETE FROM workhorse.cold_export_segment;
      DELETE FROM workhorse.cold_export_dataset;`);
    try {
      // The ledger a New York session wrote across the 2026 spring transition.
      await pool.query(`
        INSERT INTO workhorse.cold_export_dataset(dataset, exported_through)
        VALUES ('task_event', '2026-03-08T23:00Z');
        INSERT INTO workhorse.cold_export_segment(
          dataset, segment_start, segment_end, status, attempts, lease_expires_at,
          row_count, byte_length, completed_at)
        VALUES
          ('task_event', '2026-03-07T00:00Z', '2026-03-08T00:00Z', 'complete', 1, NULL,
           0, 0, now()),
          ('task_event', '2026-03-08T00:00Z', '2026-03-08T23:00Z', 'complete', 1, NULL,
           0, 0, now()),
          ('task_event', '2026-03-08T23:00Z', '2026-03-09T23:00Z', 'exporting', 1,
           now() + interval '1 hour', NULL, NULL, NULL),
          ('task_event', '2026-03-10T00:00Z', '2026-03-10T23:00Z', 'exporting', 2,
           now() + interval '1 hour', NULL, NULL, NULL);`);
    } finally {
      await pool.query(repair);
    }

    const segments = await pool.query<{
      segment_start: Date;
      segment_end: Date;
      status: string;
      attempts: number;
      lease_expires_at: Date | null;
    }>(
      `SELECT segment_start, segment_end, status, attempts, lease_expires_at
         FROM workhorse.cold_export_segment ORDER BY segment_start`,
    );
    expect(segments.rows).toEqual([
      {
        segment_start: new Date("2026-03-07T00:00Z"),
        segment_end: new Date("2026-03-08T00:00Z"),
        status: "complete",
        attempts: 1,
        lease_expires_at: null,
      },
      {
        segment_start: new Date("2026-03-08T00:00Z"),
        segment_end: new Date("2026-03-09T00:00Z"),
        status: "exporting",
        attempts: 2,
        lease_expires_at: null,
      },
      {
        segment_start: new Date("2026-03-10T00:00Z"),
        segment_end: new Date("2026-03-11T00:00Z"),
        status: "exporting",
        attempts: 3,
        lease_expires_at: null,
      },
    ]);
    const watermark = await pool.query<{ exported_through: Date }>(
      "SELECT exported_through FROM workhorse.cold_export_dataset WHERE dataset = 'task_event'",
    );
    expect(watermark.rows).toEqual([{ exported_through: new Date("2026-03-08T00:00Z") }]);
    await pool.query("DELETE FROM workhorse.cold_export_segment");
    await pool.query("DELETE FROM workhorse.cold_export_dataset");
  });

  it("fences out the exporter that wrote a damaged day once the repair queues it again", async () => {
    const repair = await readFile(
      new URL(
        "../../../sql/migrations/0052-keep-cold-export-segments-one-utc-day.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await pool.query(`
      ALTER TABLE workhorse.cold_export_dataset
        DROP CONSTRAINT cold_export_dataset_utc_midnight_check;
      ALTER TABLE workhorse.cold_export_segment DROP CONSTRAINT cold_export_segment_utc_day_check;
      DELETE FROM workhorse.cold_export_segment;
      DELETE FROM workhorse.cold_export_dataset;`);
    try {
      // Attempt 1 completed a 23-hour day that a New York session claimed across the transition.
      await pool.query(`
        INSERT INTO workhorse.cold_export_dataset(dataset, exported_through)
        VALUES ('task_event', '2026-03-08T23:00Z');
        INSERT INTO workhorse.cold_export_segment(
          dataset, segment_start, segment_end, status, attempts, row_count, byte_length,
          completed_at)
        VALUES ('task_event', '2026-03-08T00:00Z', '2026-03-08T23:00Z', 'complete', 1, 0, 0,
                now());`);
    } finally {
      await pool.query(repair);
    }
    await pool.query(
      `INSERT INTO workhorse.cold_export_policy(singleton, enabled) VALUES (true, true)
       ON CONFLICT (singleton) DO UPDATE SET enabled = true`,
    );

    const replacement = await claimSegment("task_event", "replacement");
    expect(replacement).toMatchObject({
      segment_start: new Date("2026-03-08T00:00Z"),
      segment_end: new Date("2026-03-09T00:00Z"),
    });
    // The exporter of attempt 1 replays its completion after the replacement claim.
    await expect(
      pool.query(
        `SELECT workhorse.complete_cold_export_segment_v1(
           'task_event', '2026-03-08T00:00Z', 1, NULL, 'k.manifest.json', NULL, 0, 0)`,
      ),
    ).rejects.toThrow(/is not held by attempt 1/);
    expect(replacement?.attempts).toBe(3);
    const watermark = await pool.query<{ exported_through: Date }>(
      "SELECT exported_through FROM workhorse.cold_export_dataset WHERE dataset = 'task_event'",
    );
    expect(watermark.rows).toEqual([{ exported_through: new Date("2026-03-08T00:00Z") }]);
    await pool.query("DELETE FROM workhorse.cold_export_policy");
    await pool.query("DELETE FROM workhorse.cold_export_segment");
    await pool.query("DELETE FROM workhorse.cold_export_dataset");
  });

  it("waits for a retention pass that sampled the old watermark before it rewinds", async () => {
    const repair = await readFile(
      new URL(
        "../../../sql/migrations/0052-keep-cold-export-segments-one-utc-day.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const hour = 3_600_000;
    const at = (daysAgo: number, hours = 0) => new Date(utcDay(daysAgo).getTime() + hours * hour);
    await seedHistory("cold-export-retention-race", 1, utcDay(7));
    await seedHistory("cold-export-retention-race", 1, utcDay(6));
    await pool.query(`
      ALTER TABLE workhorse.cold_export_dataset
        DROP CONSTRAINT cold_export_dataset_utc_midnight_check;
      ALTER TABLE workhorse.cold_export_segment DROP CONSTRAINT cold_export_segment_utc_day_check;
      DELETE FROM workhorse.cold_export_segment;
      DELETE FROM workhorse.cold_export_dataset;`);
    const retention = await pool.connect();
    const upgrade = await pool.connect();
    const notices: string[] = [];
    upgrade.on("notice", (notice) => notices.push(notice.message ?? ""));
    let upgraded: Promise<unknown> | undefined;
    try {
      await upgrade.query(
        "INSERT INTO workhorse.cold_export_dataset(dataset, exported_through) VALUES ('task_event', $1)",
        [at(5, -1)],
      );
      for (const [start, end] of [
        [at(8), at(7)],
        [at(7), at(7, 23)],
        [at(7, 23), at(6, 23)],
        [at(6, 23), at(5, 23)],
      ]) {
        await upgrade.query(
          `INSERT INTO workhorse.cold_export_segment(
             dataset, segment_start, segment_end, status, attempts, row_count, byte_length,
             completed_at)
           VALUES ('task_event', $1, $2, 'complete', 1, 0, 0, now())`,
          [start, end],
        );
      }
      // A retention pass holds its lock and deletes, under the old watermark, the first day the
      // repair would otherwise rewind to. It has not committed when the upgrade starts.
      await retention.query("BEGIN");
      await retention.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('workhorse:maintenance:history-retention', 0))",
      );
      await retention.query("DELETE FROM workhorse.task_event_default WHERE occurred_at < $1", [
        utcDay(6),
      ]);
      upgraded = upgrade.query(repair);
      const pid = (upgrade as unknown as { processID: number }).processID;
      // Wait until the upgrade blocks on a maintenance lock, or finishes because it took none.
      const state = { settled: false };
      void upgraded.then(
        () => (state.settled = true),
        () => (state.settled = true),
      );
      for (let poll = 0; poll < 100 && !state.settled; poll += 1) {
        const waiting = await pool.query(
          "SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted",
          [pid],
        );
        if (waiting.rowCount !== 0) break;
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      await retention.query("COMMIT");
      await upgraded;
    } finally {
      await retention.query("ROLLBACK").catch(() => undefined);
      await upgraded?.catch(() => undefined);
      retention.release();
      upgrade.release();
    }

    // The repair saw the committed deletion, so it resumes at the oldest day still held and warns.
    const watermark = await pool.query<{ exported_through: Date }>(
      "SELECT exported_through FROM workhorse.cold_export_dataset WHERE dataset = 'task_event'",
    );
    expect(watermark.rows).toEqual([{ exported_through: utcDay(6) }]);
    expect(notices.filter((notice) => notice.includes("cannot re-export"))).toEqual([
      expect.stringContaining("cold export of task_event cannot re-export the days from"),
    ]);
    await pool.query("DELETE FROM workhorse.cold_export_segment");
    await pool.query("DELETE FROM workhorse.cold_export_dataset");
  });

  it("locks every dataset before it looks for damage, so an exporter cannot slip a day past it", async () => {
    const repair = await readFile(
      new URL(
        "../../../sql/migrations/0052-keep-cold-export-segments-one-utc-day.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await pool.query(`
      ALTER TABLE workhorse.cold_export_dataset
        DROP CONSTRAINT cold_export_dataset_utc_midnight_check;
      ALTER TABLE workhorse.cold_export_segment DROP CONSTRAINT cold_export_segment_utc_day_check;
      DELETE FROM workhorse.cold_export_segment;
      DELETE FROM workhorse.cold_export_dataset;`);
    await pool.query(
      `INSERT INTO workhorse.cold_export_policy(singleton, enabled) VALUES (true, true)
       ON CONFLICT (singleton) DO UPDATE SET enabled = true`,
    );
    // task_event is still exporting the 23-hour day a New York session claimed, so it has no
    // damaged complete segment yet. attempt_history has one, and its row is locked elsewhere.
    await pool.query(`
      INSERT INTO workhorse.cold_export_dataset(dataset, exported_through)
      VALUES ('task_event', '2026-03-08T00:00Z'), ('attempt_history', '2026-03-08T23:00Z');
      INSERT INTO workhorse.cold_export_segment(
        dataset, segment_start, segment_end, status, attempts, exporter_id, lease_expires_at,
        row_count, byte_length, completed_at)
      VALUES
        ('task_event', '2026-03-08T00:00Z', '2026-03-08T23:00Z', 'exporting', 1, 'old',
         now() + interval '1 hour', NULL, NULL, NULL),
        ('attempt_history', '2026-03-08T00:00Z', '2026-03-08T23:00Z', 'complete', 1, NULL, NULL,
         0, 0, now());`);
    const blocker = await pool.connect();
    const upgrade = await pool.connect();
    const exporter = await pool.connect();
    const complete = (start: string, attempts: number) =>
      exporter.query(
        `SELECT workhorse.complete_cold_export_segment_v1(
           'task_event', $1, $2, $3, $4, $5, 100, 1)`,
        [start, attempts, `k/${start}`, `k/${start}.manifest.json`, "0".repeat(64)],
      );
    const settled = async (promise: Promise<unknown>, pid: number) => {
      const state = { settled: false };
      void promise.then(
        () => (state.settled = true),
        () => (state.settled = true),
      );
      for (let poll = 0; poll < 100 && !state.settled; poll += 1) {
        const waiting = await pool.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted", [
          pid,
        ]);
        if (waiting.rowCount !== 0) break;
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
    };
    let upgraded: Promise<unknown> | undefined;
    let exported: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM workhorse.cold_export_dataset WHERE dataset = 'attempt_history' FOR UPDATE",
      );
      upgraded = upgrade.query(repair);
      await settled(upgraded, pidOf(upgrade));
      // While the upgrade waits, the old exporter completes its day, overwriting the March 8
      // object with a 23-hour range, then claims and completes the next 24 hours.
      exported = (async () => {
        await complete("2026-03-08T00:00Z", 1);
        const next = await exporter.query<Claim>(
          "SELECT * FROM workhorse.claim_cold_export_segment_v1('task_event', 'old', 60000)",
        );
        await complete("2026-03-08T23:00Z", next.rows[0]!.attempts);
      })();
      await settled(exported, pidOf(exporter));
      await blocker.query("COMMIT");
      await upgraded;
      // The repair locked the ledger first, so the stale completion no longer matches the fence.
      await expect(exported).rejects.toThrow(/is not held by attempt 1/);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await upgraded?.catch(() => undefined);
      await exported?.catch(() => undefined);
      blocker.release();
      upgrade.release();
      exporter.release();
    }

    // March 8 still has retained source rows, so the export must return to it.
    const watermark = await pool.query<{ exported_through: Date }>(
      "SELECT exported_through FROM workhorse.cold_export_dataset WHERE dataset = 'task_event'",
    );
    expect(watermark.rows).toEqual([{ exported_through: new Date("2026-03-08T00:00Z") }]);
    expect(await claimSegment("task_event", "replacement")).toMatchObject({
      segment_start: new Date("2026-03-08T00:00Z"),
      segment_end: new Date("2026-03-09T00:00Z"),
    });
    await pool.query("DELETE FROM workhorse.cold_export_policy");
    await pool.query("DELETE FROM workhorse.cold_export_segment");
    await pool.query("DELETE FROM workhorse.cold_export_dataset");
  });

  it("rewinds a repaired ledger to the first overwritten day that retention still holds", async () => {
    const repair = await readFile(
      new URL(
        "../../../sql/migrations/0052-keep-cold-export-segments-one-utc-day.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const hour = 3_600_000;
    const at = (daysAgo: number, hours = 0) => new Date(utcDay(daysAgo).getTime() + hours * hour);
    const sevenDaysAgo = await seedHistory("cold-export-overwritten", 1, utcDay(7));
    const sixDaysAgo = await seedHistory("cold-export-overwritten", 1, utcDay(6));
    // Attempt history of the first overwritten day is already gone, as retention would leave it.
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = ANY($1::uuid[])", [
      sevenDaysAgo,
    ]);
    await pool.query(`
      ALTER TABLE workhorse.cold_export_dataset
        DROP CONSTRAINT cold_export_dataset_utc_midnight_check;
      ALTER TABLE workhorse.cold_export_segment DROP CONSTRAINT cold_export_segment_utc_day_check;
      DELETE FROM workhorse.cold_export_segment;
      DELETE FROM workhorse.cold_export_dataset;`);
    const notices: string[] = [];
    const client = await pool.connect();
    client.on("notice", (notice) => notices.push(notice.message ?? ""));
    try {
      // A spring transition seven days ago: a 23-hour day, then days that start an hour early. The
      // second segment shares the first one's UTC day, so its object overwrote that day's object.
      for (const dataset of ["task_event", "attempt_history"]) {
        await client.query(
          "INSERT INTO workhorse.cold_export_dataset(dataset, exported_through) VALUES ($1, $2)",
          [dataset, at(5, -1)],
        );
        for (const [start, end] of [
          [at(8), at(7)],
          [at(7), at(7, 23)],
          [at(7, 23), at(6, 23)],
          [at(6, 23), at(5, 23)],
        ]) {
          await client.query(
            `INSERT INTO workhorse.cold_export_segment(
               dataset, segment_start, segment_end, status, attempts, row_count, byte_length,
               completed_at)
             VALUES ($1, $2, $3, 'complete', 1, 0, 0, now())`,
            [dataset, start, end],
          );
        }
      }
    } finally {
      try {
        await client.query(repair);
      } finally {
        client.release();
      }
    }

    const watermarks = await pool.query<{ dataset: string; exported_through: Date }>(
      "SELECT dataset, exported_through FROM workhorse.cold_export_dataset ORDER BY dataset",
    );
    expect(watermarks.rows).toEqual([
      { dataset: "attempt_history", exported_through: utcDay(6) },
      { dataset: "task_event", exported_through: utcDay(7) },
    ]);
    expect(notices.filter((notice) => notice.includes("cannot re-export"))).toEqual([
      expect.stringContaining("cold export of attempt_history cannot re-export the days from"),
    ]);

    // Retention reads the rewound watermark, so it keeps the overwritten days for the export.
    await queue.setColdExportPolicy({ enabled: true });
    await queue.syncRetentionPolicy({
      ...defaultRetentionPolicy,
      taskEventRetentionDays: 1,
      attemptHistoryRetentionDays: 1,
    });
    await queue.retainHistory({ force: true });
    const sevenDaysAgoEvents = await historyIds("task_event", utcDay(7));
    const sixDaysAgoEvents = await historyIds("task_event", utcDay(6));
    expect(sevenDaysAgoEvents.length).toBeGreaterThan(0);
    expect(sixDaysAgoEvents.length).toBeGreaterThan(0);
    expect(await historyIds("attempt_history", utcDay(6))).toHaveLength(sixDaysAgo.length);

    const first = await exportNextDay("task_event");
    expect(first?.claim.segment_start).toEqual(utcDay(7));
    expect(first?.ids).toEqual(sevenDaysAgoEvents);
    const second = await exportNextDay("task_event");
    expect(second?.claim.segment_start).toEqual(utcDay(6));
    expect(second?.ids).toEqual(sixDaysAgoEvents);
    const attempts = await exportNextDay("attempt_history");
    expect(attempts?.claim.segment_start).toEqual(utcDay(6));
    expect(attempts?.ids).toHaveLength(sixDaysAgo.length);
  });

  it("never exports again a day that retention pruned after its archive object was written", async () => {
    const repair = await readFile(
      new URL(
        "../../../sql/migrations/0052-keep-cold-export-segments-one-utc-day.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const hour = 3_600_000;
    const at = (daysAgo: number, hours = 0) => new Date(utcDay(daysAgo).getTime() + hours * hour);
    await admin.setQueueTier("cold-export-pruned", "fast", adminAudit("move to the fast tier"));
    const ids: string[] = [];
    const worker = new Worker(queue, { workerId: "pruned", queue: "cold-export-pruned" }).handle(
      "pruned",
      () => ({ ok: true }),
    );
    for (const finishedAt of [at(7, 1), at(7, 22)]) {
      const id = await queue.enqueue("pruned", {}, { queue: "cold-export-pruned" });
      expect(await worker.runOnce()).toBe(true);
      await pool.query(
        "UPDATE workhorse.fast_task_outcome SET finished_at = $2 WHERE task_id = $1",
        [id, finishedAt],
      );
      ids.push(id);
    }
    await pool.query(`
      ALTER TABLE workhorse.cold_export_dataset
        DROP CONSTRAINT cold_export_dataset_utc_midnight_check;
      ALTER TABLE workhorse.cold_export_segment DROP CONSTRAINT cold_export_segment_utc_day_check;
      DELETE FROM workhorse.cold_export_segment;
      DELETE FROM workhorse.cold_export_dataset;`);
    const notices: string[] = [];
    const client = await pool.connect();
    client.on("notice", (notice) => notices.push(notice.message ?? ""));
    try {
      // A 23-hour day archived both outcomes. Retention then removed the earlier one, which the
      // fast tier does row by row, so only the later outcome of that day survives.
      await client.query(
        `INSERT INTO workhorse.cold_export_dataset(dataset, exported_through)
         VALUES ('fast_task_outcome', $1)`,
        [at(7, 23)],
      );
      await client.query(
        `INSERT INTO workhorse.cold_export_segment(
           dataset, segment_start, segment_end, status, attempts, object_key, manifest_key,
           checksum_sha256, row_count, byte_length, completed_at)
         VALUES ('fast_task_outcome', $1, $2, 'complete', 1, 'archive/day', 'archive/day.manifest',
                 $3, 2, 200, now())`,
        [at(7), at(7, 23), "0".repeat(64)],
      );
      await client.query("DELETE FROM workhorse.task WHERE id = $1", [ids[0]]);
    } finally {
      try {
        await client.query(repair);
      } finally {
        client.release();
      }
    }

    expect(notices.filter((notice) => notice.includes("cannot re-export"))).toEqual([
      expect.stringContaining("cold export of fast_task_outcome cannot re-export the days from"),
    ]);
    const watermark = await pool.query<{ exported_through: Date }>(
      `SELECT exported_through FROM workhorse.cold_export_dataset
        WHERE dataset = 'fast_task_outcome'`,
    );
    expect(watermark.rows).toEqual([{ exported_through: utcDay(6) }]);

    // No exporter is ever handed the pruned day, so nothing rewrites its object with one row.
    await queue.setColdExportPolicy({ enabled: true });
    const exported: Date[] = [];
    for (let next = await exportNextDay("fast_task_outcome", 100); next !== null;) {
      exported.push(next.claim.segment_start);
      next = await exportNextDay("fast_task_outcome", 100);
    }
    expect(exported[0]).toEqual(utcDay(6));
    expect(exported).not.toContainEqual(utcDay(7));
    await queue.setColdExportPolicy({ enabled: false });
    await pool.query("DELETE FROM workhorse.cold_export_segment");
    await pool.query("DELETE FROM workhorse.cold_export_dataset");
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
