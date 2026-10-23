import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

// Migration 0085 (SM-1665) makes two advisory lock keys unambiguous. A history-day key no longer
// depends on the session DateStyle or TimeZone. A schedule occurrence key keeps the namespace, the
// name, and the second as separate values. A history partition name no longer depends on the
// session TimeZone.
//
// The DateStyle, partition name, and colon cases fail on the bodies before that migration. Those
// bodies wrote the day key with `date || text`, which reads no TimeZone. Thus the Pacific/Apia lock
// cases of retire_history_partitions_v1 and retire_history_day_v1 guard the cast to timestamp.
// Without that cast, to_char reads the session TimeZone. The last test guards duplicate-occurrence
// protection, which does not change.

interface SessionSettings {
  dateStyle: string;
  timeZone?: string;
}

/** Opens a transaction on a pooled connection with settings that last until it ends. */
async function sessionWith({ dateStyle, timeZone = "UTC" }: SessionSettings): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT set_config('datestyle', $1, true), set_config('timezone', $2, true)", [
    dateStyle,
    timeZone,
  ]);
  return client;
}

async function finish(...clients: PoolClient[]): Promise<void> {
  for (const client of clients) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

type DayLockCall =
  | "retire_history_partitions_v1"
  | "create_history_day_v1"
  | "retire_history_day_v1";

/** The UTC midnight after `day`, which retires `day` as the retirement bound. */
function nextUtcMidnight(day: string): string {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/** Calls one day-lock function in `other` and reports whether the held day lock stopped it. */
async function dayLockOutcome(
  other: PoolClient,
  call: DayLockCall,
  day: string,
): Promise<"stopped" | "ran"> {
  if (call === "retire_history_partitions_v1") {
    // The try-lock skips a busy day, so the call retires nothing.
    const retired = await other.query<{ retired: number }>(
      "SELECT workhorse.retire_history_partitions_v1('task_event', $1, 1) AS retired",
      [nextUtcMidnight(day)],
    );
    return retired.rows[0]?.retired === 0 ? "stopped" : "ran";
  }
  // The blocking lock waits for the holder, so the lock timeout ends the call.
  await other.query("SET LOCAL lock_timeout = '100ms'");
  try {
    await other.query(`SELECT workhorse.${call}($1)`, [day]);
    return "ran";
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") return "stopped";
    throw error;
  }
}

/** Reports whether both history partitions of `day` exist. */
async function partitionsOf(day: string): Promise<{ events: boolean; attempts: boolean }> {
  const suffix = day.replaceAll("-", "");
  const found = await pool.query<{ events: boolean; attempts: boolean }>(
    `SELECT to_regclass('workhorse.task_event_${suffix}') IS NOT NULL AS events,
            to_regclass('workhorse.attempt_history_${suffix}') IS NOT NULL AS attempts`,
  );
  return found.rows[0]!;
}

const sqlDmy = { dateStyle: "SQL, DMY" };
const german = { dateStyle: "German" };
const isoMdy = { dateStyle: "ISO, MDY" };
const sqlMdy = { dateStyle: "SQL, MDY" };
const postgresMdy = { dateStyle: "Postgres, MDY" };
const isoDmy = { dateStyle: "ISO, DMY" };
// Pacific/Apia has no local 2011-12-30, so a cast of that date to timestamptz gives 2011-12-31.
const isoApia = { dateStyle: "ISO, MDY", timeZone: "Pacific/Apia" };

const dayLockCases: [DayLockCall, string, SessionSettings, SessionSettings][] = [
  ["retire_history_partitions_v1", "2014-03-03", sqlDmy, german],
  ["retire_history_partitions_v1", "2014-03-03", isoMdy, sqlMdy],
  ["retire_history_partitions_v1", "2014-03-03", postgresMdy, isoDmy],
  ["retire_history_partitions_v1", "2011-12-30", isoApia, isoMdy],
  ["create_history_day_v1", "2014-03-03", sqlDmy, german],
  ["create_history_day_v1", "2014-03-03", isoMdy, postgresMdy],
  ["create_history_day_v1", "2011-12-30", isoMdy, isoApia],
  ["retire_history_day_v1", "2014-03-03", sqlMdy, isoDmy],
  ["retire_history_day_v1", "2014-03-03", german, isoMdy],
  ["retire_history_day_v1", "2011-12-30", isoApia, isoMdy],
];

describe("history-day advisory locks", () => {
  // A call of create_history_day_v1 for a day whose partitions exist takes only the day lock and
  // returns. The holder therefore holds no parent lock, and only the day lock can stop the other
  // session.
  it.each(dayLockCases)(
    "stops %s for %s in session %o while session %o holds the day",
    async (call, day, otherSettings, holderSettings) => {
      await pool.query("SELECT workhorse.create_history_day_v1($1)", [day]);
      const holder = await sessionWith(holderSettings);
      const other = await sessionWith(otherSettings);
      try {
        await holder.query("SELECT workhorse.create_history_day_v1($1)", [day]);
        expect(await dayLockOutcome(other, call, day)).toBe("stopped");
      } finally {
        await finish(other, holder);
      }

      // Both partitions of the day still exist after the holder ends.
      expect(await partitionsOf(day)).toEqual({ events: true, attempts: true });
    },
  );
});

const occurrence = "2026-09-14T10:01:00Z";

async function syncColonSchedules(): Promise<{ held: bigint; other: bigint }> {
  const definition = {
    schedule: "0 * * * * *",
    task: { type: "colon-lock", payload: null },
  };
  // ("colon:a", "b") and ("colon", "a:b") joined with colons give one text.
  await queue.syncSchedules("colon:a", [{ name: "b", ...definition }]);
  await queue.syncSchedules("colon", [{ name: "a:b", ...definition }]);
  await pool.query(
    `UPDATE workhorse.schedule_definition
        SET last_evaluated_at = '2026-09-14T10:00:30Z'
      WHERE namespace IN ('colon:a', 'colon')`,
  );
  const [held] = await queue.schedules(["colon:a"]);
  const [other] = await queue.schedules(["colon"]);
  return { held: held!.revision, other: other!.revision };
}

async function holdColonOccurrence(revision: bigint): Promise<PoolClient> {
  const holder = await pool.connect();
  await holder.query("BEGIN");
  const held = await holder.query<{ task_id: string | null }>(
    "SELECT workhorse.fire_schedule_v1($1::text, $2::text, $3::bigint, $4::timestamptz) AS task_id",
    ["colon:a", "b", revision.toString(), occurrence],
  );
  expect(held.rows[0]?.task_id).not.toBeNull();
  return holder;
}

describe("history partition names", () => {
  it("names the partition of a day after that UTC day in a zone that skipped the day", async () => {
    const apia = await sessionWith(isoApia);
    try {
      await apia.query("SELECT workhorse.create_history_day_v1($1)", ["2011-12-30"]);
      await apia.query("COMMIT");
    } finally {
      await finish(apia);
    }
    expect(await partitionsOf("2011-12-30")).toEqual({ events: true, attempts: true });
    expect(await partitionsOf("2011-12-31")).toEqual({ events: false, attempts: false });
  });

  it("prepares the partition of a day in a zone that skipped the day", async () => {
    // Only the next day exists. A preparation that names 2011-12-30 after 2011-12-31 finds that
    // name and skips the day.
    await pool.query("SELECT workhorse.retire_history_day_v1($1)", ["2011-12-30"]);
    await pool.query("SELECT workhorse.create_history_day_v1($1)", ["2011-12-31"]);
    expect(await partitionsOf("2011-12-30")).toEqual({ events: false, attempts: false });
    const apia = await sessionWith(isoApia);
    try {
      await apia.query("SELECT * FROM workhorse.prepare_history_partitions_v1(true, $1)", [
        "2011-12-30T12:00:00Z",
      ]);
      await apia.query("COMMIT");
    } finally {
      await finish(apia);
    }
    expect(await partitionsOf("2011-12-30")).toEqual({ events: true, attempts: true });
    expect(await partitionsOf("2011-12-31")).toEqual({ events: true, attempts: true });
  });
});

// The repair block at the end of migration 0085 renames a history partition that has the name of
// the wrong UTC day. An earlier body made that shape in a session time zone that skipped a calendar
// day, for example 2011-12-30 in Pacific/Apia. The repair reads only bounds, so the cases below
// plant the shape for other days.
const migration0085 = await readFile(
  new URL(
    "../../../sql/migrations/0085-make-the-day-and-schedule-lock-keys-unambiguous.sql",
    import.meta.url,
  ),
  "utf8",
);
const partitionNameRepair = /^DO \$repair\$[\s\S]*?^\$repair\$;$/m.exec(migration0085)![0];

/** Runs the repair under the lock timeout of the migration runner, and returns its notices. */
async function repairPartitionNames(lockTimeoutMs = 5000): Promise<string[]> {
  const client = await pool.connect();
  const notices: string[] = [];
  const onNotice = (notice: { message?: string }) => notices.push(notice.message ?? "");
  client.on("notice", onNotice);
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = ${String(lockTimeoutMs)}`);
    // The repair reads bounds that pg_get_expr writes with the session settings.
    await client.query("SET LOCAL datestyle = 'German'");
    await client.query("SET LOCAL timezone = 'Pacific/Apia'");
    await client.query(partitionNameRepair);
    await client.query("COMMIT");
  } finally {
    client.off("notice", onNotice);
    await finish(client);
  }
  return notices;
}

/** Creates a child of `parent` named `name` that holds the UTC days from `from` to `to`. */
async function plantPartition(parent: string, name: string, from: string, to: string) {
  await pool.query(
    `CREATE TABLE workhorse.${name} PARTITION OF workhorse.${parent}
       FOR VALUES FROM ('${from} 00:00:00+00') TO ('${to} 00:00:00+00')`,
  );
}

describe("history partition name repair", () => {
  it("renames a partition that has the name of the next day", async () => {
    await plantPartition("attempt_history", "attempt_history_20150611", "2015-06-10", "2015-06-11");
    await plantPartition("task_event", "task_event_20150611", "2015-06-10", "2015-06-11");
    await expect(
      pool.query("SELECT workhorse.create_history_day_v1($1)", ["2015-06-10"]),
    ).rejects.toThrow(/would overlap partition/);

    expect(await repairPartitionNames()).toEqual([]);
    expect(await partitionsOf("2015-06-10")).toEqual({ events: true, attempts: true });
    expect(await partitionsOf("2015-06-11")).toEqual({ events: false, attempts: false });

    // Before the repair, this call dropped the partitions that hold 2015-06-10.
    await pool.query("SELECT workhorse.retire_history_day_v1($1)", ["2015-06-11"]);
    expect(await partitionsOf("2015-06-10")).toEqual({ events: true, attempts: true });

    await pool.query("SELECT * FROM workhorse.prepare_history_partitions_v1(true, $1)", [
      "2015-06-10T12:00:00Z",
    ]);
    expect(await partitionsOf("2015-06-11")).toEqual({ events: true, attempts: true });

    // Earlier cases in this file leave older days, which this pass also retires.
    await pool.query(
      `SELECT workhorse.retire_history_partitions_v1('task_event', $1, 52),
              workhorse.retire_history_partitions_v1('attempt_history', $1, 52)`,
      ["2015-06-11T00:00:00Z"],
    );
    expect(await partitionsOf("2015-06-10")).toEqual({ events: false, attempts: false });
    expect(await partitionsOf("2015-06-11")).toEqual({ events: true, attempts: true });
  });

  it("stops at the lock timeout when a long transaction holds the shifted partition", async () => {
    await plantPartition("task_event", "task_event_20170506", "2017-05-05", "2017-05-06");
    const reader = await pool.connect();
    try {
      await reader.query("BEGIN");
      await reader.query("SELECT count(*) FROM workhorse.task_event_20170506");
      await expect(repairPartitionNames(200)).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await finish(reader);
    }
    expect(await repairPartitionNames()).toEqual([]);
    const renamed = await pool.query<{ shifted: boolean; correct: boolean }>(
      `SELECT to_regclass('workhorse.task_event_20170506') IS NOT NULL AS shifted,
              to_regclass('workhorse.task_event_20170505') IS NOT NULL AS correct`,
    );
    expect(renamed.rows[0]).toEqual({ shifted: false, correct: true });
  });

  it("keeps a shifted name when the correct name is taken, and a child that spans two days", async () => {
    await plantPartition("task_event", "task_event_20160311", "2016-03-10", "2016-03-11");
    await pool.query("CREATE TABLE workhorse.task_event_20160310 (planted integer)");
    await plantPartition("task_event", "task_event_two_days", "2016-04-01", "2016-04-03");
    try {
      expect(await repairPartitionNames()).toEqual([
        "history partition workhorse.task_event_20160311 keeps its name: " +
          "workhorse.task_event_20160310 already exists",
      ]);
      const names = await pool.query<{ shifted: boolean; taken: boolean; span: boolean }>(
        `SELECT to_regclass('workhorse.task_event_20160311') IS NOT NULL AS shifted,
                to_regclass('workhorse.task_event_20160310') IS NOT NULL AS taken,
                to_regclass('workhorse.task_event_two_days') IS NOT NULL AS span`,
      );
      expect(names.rows[0]).toEqual({ shifted: true, taken: true, span: true });
      const planted = await pool.query<{ relkind: string }>(
        "SELECT relkind FROM pg_class WHERE oid = 'workhorse.task_event_20160310'::regclass",
      );
      expect(planted.rows[0]?.relkind).toBe("r");
    } finally {
      await pool.query(
        `DROP TABLE IF EXISTS workhorse.task_event_20160311, workhorse.task_event_20160310,
           workhorse.task_event_two_days`,
      );
    }
  });
});

describe("schedule occurrence advisory locks", () => {
  it("fires a schedule whose colon tuple shared a lock with a held occurrence", async () => {
    const revisions = await syncColonSchedules();
    const holder = await holdColonOccurrence(revisions.held);
    try {
      const fired = await pool.query<{ task_id: string | null }>(
        "SELECT workhorse.fire_schedule_v1($1::text, $2::text, $3::bigint, $4::timestamptz) AS task_id",
        ["colon", "a:b", revisions.other.toString(), occurrence],
      );
      expect(fired.rows[0]?.task_id).not.toBeNull();
    } finally {
      await finish(holder);
    }
  });

  it("does not defer a schedule whose colon tuple shared a lock with a held occurrence", async () => {
    const revisions = await syncColonSchedules();
    const holder = await holdColonOccurrence(revisions.held);
    try {
      await queue.fireDueSchedules(["colon"], new Date("2026-09-14T10:01:30Z"), 100, 120_000);
    } finally {
      await finish(holder);
    }

    const fired = await pool.query<{ occurrence_at: Date; task_id: string | null }>(
      `SELECT occurrence_at, task_id FROM workhorse.schedule_occurrence
        WHERE namespace = 'colon' AND schedule_name = 'a:b'`,
    );
    expect(fired.rows.map((row) => row.occurrence_at.toISOString())).toEqual([
      "2026-09-14T10:01:00.000Z",
    ]);
    expect(fired.rows[0]?.task_id).not.toBeNull();
  });

  it("creates one task for one occurrence fired from sessions with different DateStyles", async () => {
    await queue.syncSchedules("date-style", [
      { name: "hourly", schedule: "0 * * * *", task: { type: "date-style", payload: null } },
    ]);
    const [definition] = await queue.schedules(["date-style"]);
    const fire =
      "SELECT workhorse.fire_schedule_v1($1::text, $2::text, $3::bigint, $4::timestamptz) AS task_id";
    const parameters = [
      "date-style",
      "hourly",
      definition!.revision.toString(),
      "2026-07-22T13:00:00Z",
    ];
    const winner = await sessionWith(sqlDmy);
    const replay = await sessionWith(german);
    try {
      const won = await winner.query<{ task_id: string | null }>(fire, parameters);
      const replayed = await replay.query<{ task_id: string | null }>(fire, parameters);
      expect(won.rows[0]?.task_id).not.toBeNull();
      expect(replayed.rows[0]?.task_id).toBeNull();
      await winner.query("COMMIT");
      await replay.query("COMMIT");
    } finally {
      await finish(replay, winner);
    }

    await expect(
      pool.query(
        `SELECT (SELECT count(*)::integer FROM workhorse.task WHERE task_type = 'date-style') AS tasks,
                (SELECT count(*)::integer FROM workhorse.schedule_occurrence
                  WHERE namespace = 'date-style') AS occurrences`,
      ),
    ).resolves.toMatchObject({ rows: [{ tasks: 1, occurrences: 1 }] });
  });
});
