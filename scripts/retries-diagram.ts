import { Diagram, MONO, type Theme } from "./diagram-svg.js";

type Kind = "focal" | "backend" | "store" | "external";

/**
 * The two diagrams of `docs/guides/110-retries.md`. They use the names of that guide.
 *
 * The attempts: the `provider.sync` task of "Set the attempt budget". It has an attempt budget of 5
 * and an exponential policy that waits 30 s after the first failure and doubles the wait. Attempts 1,
 * 2, 4, and 5 throw an error. The worker process stops at 90 s during attempt 3, the lease expires
 * about 30 s later, and recovery uses the same policy. Attempt 5 fails at about 480 s, and no
 * attempts are left.
 *
 * The spread: the 1,000 `provider.sync` tasks of "Choose the retry delay". With the exponential
 * policy, all of them retry at 30 s. With decorrelated jitter and a base delay of 30 s, each task
 * selects its first delay between 30 s and 90 s.
 *
 * Check each fact against its source before you change a label.
 */

const attemptsTitle = "Each failure uses one attempt, and the wait doubles after each failure";
const attemptsDescription =
  "Attempt 1 fails at 0 s and waits 30 s. Attempt 2 fails at 30 s and waits 60 s. At 90 s, the " +
  "worker stops during attempt 3. The lease expires about 30 s later, and attempt 4 waits 120 s. " +
  "Attempt 4 fails at about 240 s and waits 240 s. Attempt 5 fails at about 480 s, and Workhorse " +
  "writes a failed outcome.";

/** Seconds to x on the attempts timeline. */
const at = (seconds: number): number => 200 + seconds * 1.2;

type Wait = readonly [start: number, end: number];

const attempts: readonly (readonly [
  name: string,
  cause: string,
  lease: Wait | undefined,
  wait: Wait | undefined,
])[] = [
  ["attempt 1", "error at 0 s", undefined, [0, 30]],
  ["attempt 2", "error at 30 s", undefined, [30, 90]],
  ["attempt 3", "worker stops at 90 s", [90, 120], [120, 240]],
  ["attempt 4", "error at 240 s", undefined, [240, 480]],
  ["attempt 5", "error at 480 s", undefined, undefined],
];

/** The top of row `index` in the attempts diagram. */
const attemptY = (index: number): number => 76 + index * 52;

export const retryAttempts = {
  slug: "retry-attempts",
  title: attemptsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);

    attempts.forEach(([, , , wait], index) => {
      if (wait === undefined) return;
      d.arrow(`M ${at(wait[1])},${attemptY(index) + 36} V ${attemptY(index + 1) - 2}`);
    });

    for (const seconds of [0, 30, 90, 120, 240, 480]) {
      d.rows(at(seconds), 44, [[`${seconds} s`, 8, "soft", MONO, 400]]);
    }
    d.divider(at(0), 936, 52);

    attempts.forEach(([name, cause, lease, wait], index) => {
      const y = attemptY(index);
      d.rows(
        24,
        y + 15,
        [
          [name, 10, "ink", MONO, 400],
          [cause, 9, "muted", MONO, 400],
        ],
        "start",
      );
      if (lease !== undefined) {
        d.box(at(lease[0]), y, at(lease[1]) - at(lease[0]), 36, "external", "lease", undefined, 10);
      }
      if (wait !== undefined) {
        const label = `${wait[1] - wait[0]} s`;
        d.box(at(wait[0]), y, at(wait[1]) - at(wait[0]), 36, "store", label, undefined, 10);
      }
    });
    d.label(at(30) + 116, attemptY(0) + 12, "THE WAIT BEFORE THE NEXT ATTEMPT");
    d.box(at(480), attemptY(4), 936 - at(480), 36, "focal", "failed", "no attempts left", 11);

    d.rows(
      24,
      348,
      [
        [
          "A thrown error and an expired lease both use one attempt. The wait comes from the policy.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );

    return d.render(this.slug, 960, 364, attemptsTitle, attemptsDescription);
  },
};

const attemptEvents: readonly (readonly [time: string, kind: Kind, name: string, sub: string])[] = [
  ["0 s", "backend", "attempt 1 fails", "error · waits 30 s"],
  ["30 s", "backend", "attempt 2 fails", "error · waits 60 s"],
  ["90 s", "external", "attempt 3: worker stops", "no completion"],
  ["about 120 s", "store", "the lease expires", "waits 120 s"],
  ["240 s", "backend", "attempt 4 fails", "error · waits 240 s"],
  ["480 s", "focal", "attempt 5 fails", "failed · no attempts left"],
];

/** The attempts diagram for screens up to 600 px wide: one event on each line, in time order. */
export const retryAttemptsNarrow = {
  slug: "retry-attempts-narrow",
  title: attemptsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const pitch = 56;

    attemptEvents.forEach(([time, kind, name, sub], index) => {
      const top = 24 + index * pitch;
      if (index > 0) d.arrow(`M 240,${top - 14} V ${top - 2}`);
      d.text(24, top + 25, time, { color: "ink" });
      d.box(104, top, 272, 42, kind, name, sub, 11);
    });

    const footerY = 24 + attemptEvents.length * pitch + 8;
    d.rows(
      24,
      footerY,
      [
        ["A thrown error and an expired lease both", 9, "muted", MONO, 400],
        ["use one attempt. The wait comes from the policy.", 9, "muted", MONO, 400],
      ],
      "start",
    );

    return d.render(this.slug, 400, footerY + 32, attemptsTitle, attemptsDescription);
  },
};

const spreadTitle = "Decorrelated jitter spreads the retries of tasks that failed together";
const spreadDescription =
  "Before 0 s, the provider gets its normal load. At 0 s, the provider stops until 120 s, and 1,000 " +
  "provider.sync requests in progress fail together. With the exponential policy, the 1,000 tasks " +
  "retry together at 30 s, 90 s, and 210 s. With decorrelated jitter, the load rises smoothly to " +
  "at most about 580 requests in 5 s and falls slowly.";

/**
 * Both rows come from one simulation per policy. Other tasks arrive at the normal load. The
 * provider fails each request from 0 s to 120 s, and at 0 s, 1,000 requests in progress fail
 * together. After each failure, any task, including one of the normal load, calls `retry_delay_v1`
 * for its next delay, and its first request after the outage succeeds. The exponential policy waits
 * 30 s and doubles. Decorrelated jitter uses `baseDelayMs` 30,000 and `maxDelayMs` 600,000. The
 * normal load is an invented illustration value, and the jitter counts change with other task IDs.
 * Each count is the requests that start in one 5 s slot from -60 s to 360 s, so the 1,000 requests
 * in progress at 0 s are not in the counts.
 */
const slot = 5;
const outage = { start: 0, end: 120 };
const exponentialRequests = [
  204, 192, 180, 204, 216, 220, 204, 208, 156, 164, 176, 180, 200, 208, 208, 180, 184, 200, 1380,
  408, 388, 348, 388, 360, 336, 376, 352, 356, 408, 344, 1560, 572, 564, 552, 576, 600, 536, 568,
  552, 548, 596, 604, 388, 392, 392, 364, 380, 392, 196, 188, 204, 212, 184, 204, 1404, 416, 400,
  368, 384, 412, 220, 236, 228, 232, 224, 224, 236, 256, 236, 244, 228, 216, 228, 228, 224, 212,
  252, 232, 224, 180, 188, 212, 228, 180,
];
const jitterRequests = [
  204, 192, 180, 204, 216, 220, 204, 208, 156, 164, 176, 180, 200, 208, 208, 180, 184, 200, 268,
  306, 316, 290, 358, 340, 334, 373, 397, 463, 506, 471, 437, 435, 460, 407, 497, 476, 421, 470,
  482, 484, 546, 545, 581, 527, 463, 485, 409, 439, 406, 370, 372, 352, 305, 304, 273, 290, 280,
  257, 286, 276, 278, 285, 277, 281, 260, 274, 283, 291, 261, 280, 260, 238, 259, 251, 239, 236,
  266, 246, 236, 189, 198, 219, 232, 185,
];

/** Seconds to x on the spread axis, from -60 s to 360 s. */
const along = (seconds: number): number => 200 + ((seconds + 60) * 736) / 420;

/** Requests in one slot to bar height. Both rows use this one scale. */
const barHeight = (requests: number): number => (requests * 150) / 1_560;

export const retrySpread = {
  slug: "retry-spread",
  title: spreadTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const exponentialBase = 236;
    const jitterBase = 412;
    const barWidth = (slot * 736) / 420 - 2;

    for (const seconds of [-60, 0, 30, 90, 120, 210, 360]) {
      d.rows(along(seconds), 44, [[`${seconds} s`, 8, "soft", MONO, 400]]);
    }
    d.divider(200, 936, 52);
    d.zone(
      along(outage.start),
      72,
      along(outage.end) - along(outage.start),
      jitterBase - 72,
      "OUTAGE",
    );

    const bars = (requests: readonly number[], base: number): void => {
      requests.forEach((count, index) => {
        const start = (index - 12) * slot;
        const kind = start >= outage.start && start < outage.end ? "focal" : "store";
        d.box(along(start) + 1, base - barHeight(count), barWidth, barHeight(count), kind);
      });
    };

    d.text(24, 200, "exponential", { size: 10, color: "ink" });
    d.text(24, 215, "each task: 30 s,");
    d.text(24, 230, "then 60 s, then 120 s");
    bars(exponentialRequests, exponentialBase);
    d.label(along(210) + 96, exponentialBase - 136, "THE 1,000 SUCCEED AT ONE TIME");
    d.divider(200, 936, exponentialBase);

    d.text(24, 376, "decorrelated jitter", { size: 10, color: "ink" });
    d.text(24, 391, "baseDelayMs 30 s, the");
    d.text(24, 406, "range grows each time");
    bars(jitterRequests, jitterBase);
    d.label(along(180), jitterBase - 74, "AT MOST ABOUT 580 REQUESTS IN 5 S");
    d.rows(204, jitterBase - 30, [["NORMAL LOAD", 8, "soft", MONO, 400]], "start");
    d.divider(200, 936, jitterBase);

    d.rows(
      24,
      444,
      [
        [
          "Each bar is the requests to the provider in 5 s. Orange: they fail. Gray: they succeed.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );

    return d.render(this.slug, 960, 460, spreadTitle, spreadDescription);
  },
};

/** Seconds to x on the narrow spread axis, from -60 s to 360 s. */
const alongNarrow = (seconds: number): number => 24 + ((seconds + 60) * 352) / 420;

/** Requests in one slot to bar height on the narrow diagram. */
const barHeightNarrow = (requests: number): number => (requests * 100) / 1_560;

/** The spread diagram for screens up to 600 px wide: the row notes go above the rows. */
export const retrySpreadNarrow = {
  slug: "retry-spread-narrow",
  title: spreadTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const exponentialBase = 236;
    const jitterBase = 400;
    const barWidth = (slot * 352) / 420 - 1;

    for (const seconds of [-60, 0, 120, 210, 360]) {
      d.rows(alongNarrow(seconds), 44, [[`${seconds} s`, 8, "soft", MONO, 400]]);
    }
    d.divider(24, 376, 52);

    const outageZone = (top: number, base: number): void => {
      const x = alongNarrow(outage.start);
      d.zone(x, top, alongNarrow(outage.end) - x, base - top, "OUTAGE");
    };
    const bars = (requests: readonly number[], base: number): void => {
      requests.forEach((count, index) => {
        const start = (index - 12) * slot;
        const kind = start >= outage.start && start < outage.end ? "focal" : "store";
        const height = barHeightNarrow(count);
        d.box(alongNarrow(start) + 0.5, base - height, barWidth, height, kind);
      });
    };

    d.text(24, 76, "exponential", { size: 10, color: "ink" });
    d.text(24, 91, "each task: 30 s, then 60 s, then 120 s");
    outageZone(118, exponentialBase);
    bars(exponentialRequests, exponentialBase);
    d.rows(
      alongNarrow(210) + 8,
      exponentialBase - 84,
      [
        ["THE 1,000 SUCCEED", 8, "soft", MONO, 400],
        ["AT ONE TIME", 8, "soft", MONO, 400],
      ],
      "start",
    );
    d.divider(24, 376, exponentialBase);

    d.text(24, 260, "decorrelated jitter", { size: 10, color: "ink" });
    d.text(24, 275, "baseDelayMs 30 s, the range grows each time");
    outageZone(300, jitterBase);
    bars(jitterRequests, jitterBase);
    d.rows(
      alongNarrow(150),
      jitterBase - 58,
      [
        ["AT MOST ABOUT 580", 8, "soft", MONO, 400],
        ["REQUESTS IN 5 S", 8, "soft", MONO, 400],
      ],
      "start",
    );
    d.divider(24, 376, jitterBase);

    const footerY = jitterBase + 28;
    d.rows(
      24,
      footerY,
      [
        ["Each bar is the requests to the provider in", 9, "muted", MONO, 400],
        ["5 s. Orange: they fail. Gray: they succeed.", 9, "muted", MONO, 400],
      ],
      "start",
    );

    return d.render(this.slug, 400, footerY + 32, spreadTitle, spreadDescription);
  },
};
