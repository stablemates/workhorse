import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createIntegrationTestContext } from "./support/integration.js";

const { databaseUrl, pool, queue } = createIntegrationTestContext(import.meta.url);

/**
 * Statistics buckets must land on the UTC grid on every database, not on the grid its `TimeZone`
 * happens to name.
 *
 * The rollup bins time with `date_bin`, and `date_bin` takes an origin. A bare
 * `timestamptz '2000-01-01'` origin is not a fixed instant: PostgreSQL resolves it in the session's
 * `TimeZone`, so bucket boundaries used to follow the database's timezone and to disagree with the
 * history day partitions the same schema computes. CI runners are UTC, which is why nothing here
 * could be caught by running the ordinary suite.
 *
 * Every assertion below therefore runs on a connection whose session `TimeZone` is deliberately not
 * UTC, and each one gets its own pool so it reaches a backend that parsed the statistics functions
 * under that timezone rather than an idle one another test already warmed.
 */

/** Whole-hour offsets move the day grid; fractional offsets move the hour grid as well. */
const timezones = [
  "UTC",
  "America/New_York",
  "Australia/Sydney",
  "Asia/Kolkata",
  "Asia/Kathmandu",
] as const;

const pools: Pool[] = [];

afterAll(async () => {
  await Promise.all(pools.map((session) => session.end()));
});

/** A pool whose every connection starts in `timezone`, so no warmed backend can hide the bug. */
function sessionPool(timezone: string): Pool {
  const session = new Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `-c timezone=${timezone}`,
  });
  pools.push(session);
  return session;
}

async function completeOneTask(type: string): Promise<void> {
  const id = await queue.enqueue(type, {});
  const claimed = await queue.claim(`${type}-worker`);
  expect(claimed?.id).toBe(id);
  expect(await queue.complete(claimed!, `${type}-worker`, null)).toBe(true);
}

/**
 * Close today into every tier, the way a live installation does over a day.
 *
 * The watermarks start at today's UTC midnight and the pass is given a `now` a day ahead, so the
 * minute rows it writes roll up into complete hours and one complete day.
 */
async function rollUpThroughTomorrow(session: Pool): Promise<void> {
  await session.query(
    `UPDATE workhorse.task_stat_state
        SET rolled_up_through = date_bin('1 day', clock_timestamp(),
              timestamp '2000-01-01' AT TIME ZONE 'UTC'),
            hourly_rolled_up_through = date_bin('1 day', clock_timestamp(),
              timestamp '2000-01-01' AT TIME ZONE 'UTC'),
            daily_rolled_up_through = date_bin('1 day', clock_timestamp(),
              timestamp '2000-01-01' AT TIME ZONE 'UTC')`,
  );
  const { rows } = await session.query<{ error: unknown }>(
    `SELECT error FROM workhorse.rollup_stats_v1(true, clock_timestamp() + interval '1 day', $1)`,
    [2 * 24 * 60],
  );
  expect(rows.every((row) => row.error === null)).toBe(true);
}

/** Every stored hour and day boundary, as one reader sees it. */
async function boundaries(reader: Pool): Promise<{ tier: string; bucket_start: Date }[]> {
  const { rows } = await reader.query<{ tier: string; bucket_start: Date }>(
    `SELECT 'hour' AS tier, bucket_start FROM workhorse.task_stat_bucket_hour
     UNION ALL
     SELECT 'day' AS tier, bucket_start FROM workhorse.task_stat_bucket_day
      ORDER BY 1, 2`,
  );
  return rows;
}

describe("statistics buckets under a non-UTC database timezone", () => {
  for (const timezone of timezones) {
    it(`bins the daily tier on UTC midnight in ${timezone}`, async () => {
      const session = sessionPool(timezone);
      await completeOneTask("tz-day");
      await rollUpThroughTomorrow(session);

      // The day tier must agree with the history day partitions, which pin UTC explicitly. Reading
      // both from the database compares the two boundaries the schema actually computes.
      const { rows } = await session.query<{ bucket_start: Date; partition_day: Date }>(
        `SELECT DISTINCT bucket.bucket_start,
                date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                  AS partition_day
           FROM workhorse.task_stat_bucket_day bucket`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]!.bucket_start).toEqual(rows[0]!.partition_day);
    });

    it(`bins the hourly tier on UTC hour boundaries in ${timezone}`, async () => {
      const session = sessionPool(timezone);
      await completeOneTask("tz-hour");
      await rollUpThroughTomorrow(session);

      // A whole-hour offset leaves hour bins aligned by luck. Asia/Kolkata (+05:30) and
      // Asia/Kathmandu (+05:45) are the zones where a session-resolved origin misaligns them.
      const { rows } = await session.query<{ misaligned: string }>(
        `SELECT count(*)::text AS misaligned
           FROM workhorse.task_stat_bucket_hour bucket
          WHERE bucket.bucket_start <> date_trunc('hour', bucket.bucket_start AT TIME ZONE 'UTC')
                  AT TIME ZONE 'UTC'`,
      );

      expect(rows[0]!.misaligned).toBe("0");
      const { rows: present } = await session.query<{ hours: string }>(
        "SELECT count(*)::text AS hours FROM workhorse.task_stat_bucket_hour",
      );
      expect(Number(present[0]!.hours)).toBeGreaterThan(0);
    });

    it(`accepts a UTC-aligned window lower bound in ${timezone}`, async () => {
      const session = sessionPool(timezone);

      // stat_window_tier_v1 refuses a lower bound that is not aligned to the tier it selects. A
      // caller that aligns to UTC — which is what statWindowStart and the dashboard procedures do —
      // must not be refused because the database sits in another timezone.
      const { rows } = await session.query<{ day: string; hour: string; minute: string }>(
        `SELECT workhorse.stat_window_tier_v1(
                  date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                    - interval '90 days',
                  clock_timestamp()) AS day,
                workhorse.stat_window_tier_v1(
                  date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                    - interval '2 days',
                  clock_timestamp()) AS hour,
                workhorse.stat_window_tier_v1(
                  date_trunc('minute', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                    - interval '1 hour',
                  clock_timestamp()) AS minute`,
      );

      expect(rows[0]).toEqual({ day: "day", hour: "hour", minute: "minute" });
    });
  }

  for (const timezone of timezones) {
    it(`labels the day bucket with the UTC date at every hour of the day in ${timezone}`, async () => {
      const session = sessionPool(timezone);

      // The soak collector looks its day up by `new Date().toISOString().slice(0, 10)`, so the day
      // a bucket is binned into has to be the instant's own UTC date at every hour, not only at the
      // hours a UTC runner happens to reach. Sweeping a whole day at fifteen-minute steps covers
      // both sides of UTC midnight, and the two sweeps below cross a daylight-saving transition in
      // the northern and southern hemispheres.
      const { rows } = await session.query<{ disagreements: string }>(
        `SELECT count(*)::text AS disagreements
           FROM generate_series($1::timestamptz, $2::timestamptz, interval '15 minutes') AS instant
          WHERE to_char(date_bin('1 day', instant,
                          timestamp '2000-01-01' AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
                        'YYYY-MM-DD')
                <> to_char(instant AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
        ["2026-03-07T00:00:00Z", "2026-03-10T00:00:00Z"],
      );
      expect(rows[0]!.disagreements).toBe("0");

      const { rows: southern } = await session.query<{ disagreements: string }>(
        `SELECT count(*)::text AS disagreements
           FROM generate_series($1::timestamptz, $2::timestamptz, interval '15 minutes') AS instant
          WHERE date_bin('1 day', instant, timestamp '2000-01-01' AT TIME ZONE 'UTC')
                <> date_trunc('day', instant AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        ["2026-10-03T00:00:00Z", "2026-10-06T00:00:00Z"],
      );
      expect(southern[0]!.disagreements).toBe("0");
    });
  }

  it("agrees with the UTC session about every bucket boundary", async () => {
    await completeOneTask("tz-agreement");
    const kolkata = sessionPool("Asia/Kolkata");
    await rollUpThroughTomorrow(kolkata);

    // The pool the rest of the suite uses inherits the database's own TimeZone. Reading the same
    // rows from both sessions proves the boundaries are a property of the data, not of the reader.
    expect(await boundaries(pool)).toEqual(await boundaries(kolkata));
  });
});
