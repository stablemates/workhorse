import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/320-statistics.md`. They use the names of that guide.
 *
 * "Read counts at a bounded cost": Workhorse keeps summaries for each queue and task type. Recent
 * rows cover minutes, older rows cover hours, and the oldest rows cover days. Each row holds the
 * last error. A long window uses complete rows of each tier, and the raw history only for its
 * newest part, after the watermark.
 *
 * "See your own work in a window at once": at 10:05:02, the rollup summarizes the minute 10:04 and
 * moves the watermark to 10:05. A query for the last hour at 10:05:40 reads the summary rows before
 * the watermark and counts the part after it from the raw history. If the rollup is late, the raw
 * part is longer, and the answer stays correct.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

function eventList(
  d: Diagram,
  events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[],
  lines: readonly string[],
): number {
  const pitch = 56;
  events.forEach(([label, kind, name, sub], index) => {
    const top = 24 + index * pitch;
    if (index > 0) d.arrow(`M 248,${top - 14} V ${top - 2}`);
    d.text(24, top + 25, label, { color: "ink" });
    d.box(112, top, 264, 42, kind, name, sub, 11);
  });
  const footerY = 24 + events.length * pitch + 8;
  d.rows(
    24,
    footerY,
    lines.map((line) => [line, 9, "muted", MONO, 400] as const),
    "start",
  );
  return footerY + 17 + lines.length * 15;
}

const tiersTitle = "Workhorse counts from summary rows, so a count stays fast as the history grows";
const tiersDescription =
  "Workhorse keeps summary rows for each queue and task type. The oldest history has day rows, " +
  "older history has hour rows, and recent history has minute rows. Each row holds the last error. " +
  "Only the newest part, after the watermark, is read from the raw history.";

const segments: readonly (readonly [
  x: number,
  width: number,
  kind: Kind,
  name: string,
  sub: string,
])[] = [
  [24, 300, "store", "day rows", "the oldest history"],
  [332, 236, "store", "hour rows", "older history"],
  [576, 200, "store", "minute rows", "recent history"],
  [784, 152, "external", "raw history", "after the watermark"],
];

/** The tier diagram: the history from old to new, with the rows that summarize each part. */
export const statisticsTiers = {
  slug: "statistics-tiers",
  title: tiersTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(24, 40, [["older", 9, "soft", MONO, 400]], "start");
    d.rows(936, 40, [["now", 9, "soft", MONO, 400]]);
    d.arrow("M 72,37 H 900");
    segments.forEach(([x, width, kind, name, sub]) => {
      d.box(x, 60, width, 52, kind, name, sub, 11);
    });
    d.box(
      24,
      136,
      752,
      44,
      "focal",
      "one row for each queue and task type in each period",
      "it counts tasks and attempts, and holds the last error",
      11,
    );
    d.rows(
      24,
      212,
      [
        [
          "A count reads a bounded number of summary rows, and the raw history only for its newest part.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 228, tiersTitle, tiersDescription);
  },
};

/** The tier diagram for screens up to 600 px wide: one tier on each line. */
export const statisticsTiersNarrow = {
  slug: "statistics-tiers-narrow",
  title: tiersTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["oldest", "store", "day rows", "one row for each queue and type"],
        ["older", "store", "hour rows", "one row for each queue and type"],
        ["recent", "store", "minute rows", "one row for each queue and type"],
        ["newest", "external", "raw history", "after the watermark"],
      ],
      ["A count reads a bounded number of", "summary rows, not the full history."],
    );
    return d.render(this.slug, 400, height, tiersTitle, tiersDescription);
  },
};

const windowTitle = "A window reads summary rows before the watermark and raw history after it";
const windowDescription =
  "At 10:05:02, the rollup summarizes the minute 10:04 and moves the watermark to 10:05. At " +
  "10:05:40, an operator asks for the last hour. Workhorse reads the summary rows before the " +
  "watermark and counts the part from 10:05 to 10:05:40 from the raw history. If the rollup is late, " +
  "the raw part is longer, and the answer stays correct.";

/** The window diagram: the last hour, split at the watermark. */
export const statisticsWindow = {
  slug: "statistics-window",
  title: windowTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const split = 680;
    d.rows(
      24,
      40,
      [
        ["the last hour", 12, "ink", SANS, 600],
        ["asked at 10:05:40", 9, "muted", MONO, 400],
      ],
      "start",
    );

    d.text(24, 101, "rollup", { size: 10, color: "ink" });
    d.arrow(`M ${split},112 V 146`);
    d.box(split - 118, 72, 236, 40, "backend", "10:05:02 · rollup", "summarizes 10:04", 11);

    d.text(24, 177, "window", { size: 10, color: "ink" });
    d.box(200, 152, split - 200 - 4, 48, "store", "summary rows", "before the watermark", 11);
    d.box(split + 4, 152, 936 - split - 4, 48, "focal", "raw history", "10:05 to 10:05:40", 11);
    d.label(split, 208, "WATERMARK 10:05");

    d.rows(
      24,
      252,
      [
        [
          "Your own work counts at once. If the rollup is late, the raw part is longer, and the answer stays correct.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 268, windowTitle, windowDescription);
  },
};

/** The window diagram for screens up to 600 px wide: one event on each line. */
export const statisticsWindowNarrow = {
  slug: "statistics-window-narrow",
  title: windowTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["10:05:02", "backend", "the rollup summarizes 10:04", "the watermark moves to 10:05"],
        ["10:05:40", "store", "summary rows", "before the watermark"],
        ["", "focal", "raw history", "10:05 to 10:05:40"],
      ],
      ["If the rollup is late, the raw part is", "longer, and the answer stays correct."],
    );
    return d.render(this.slug, 400, height, windowTitle, windowDescription);
  },
};
