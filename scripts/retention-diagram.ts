import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `docs/guides/330-retention.md`. It uses the names of that guide.
 *
 * "Set how long Workhorse keeps each kind of data": the event window is 14 days, and the daily
 * history pass runs at 03:00 UTC. Its cutoff is the start of the UTC day that is the window before
 * the pass. Thus the day-15 pass keeps day 1, the event becomes 14 days old at 10:00 with no
 * deletion, and the day-16 pass drops the whole day-1 partition. A window is a minimum, not a
 * deadline.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";
type Cell = readonly [kind: Kind, name: string, sub: string] | undefined;

const title = "A window is a minimum: the event stays until the pass after it expires";
const description =
  "The event window is 14 days, and the history pass runs each day at 03:00 UTC. A task writes an " +
  "event on day 1 at 10:00. On day 15 at 03:00, the cutoff is the start of day 1, so the pass keeps " +
  "the event. At 10:00 the event is 14 days old, and no routine deletes it yet. On day 16 at 03:00, " +
  "the cutoff is the start of day 2, and the pass drops the day-1 partition.";

const columns = ["day 1 · 10:00", "day 15 · 03:00", "day 15 · 10:00", "day 16 · 03:00"] as const;

const rows: readonly (readonly [name: string, cells: readonly Cell[]])[] = [
  [
    "event",
    [
      ["store", "written", "in the day-1 partition"],
      ["store", "kept", "not older than the cutoff"],
      ["external", "14 days old", "no routine deletes it yet"],
      ["focal", "deleted", "with the day-1 partition"],
    ],
  ],
  [
    "history pass",
    [
      undefined,
      ["backend", "cutoff: start of day 1", "keeps day 1"],
      undefined,
      ["backend", "cutoff: start of day 2", "drops day 1"],
    ],
  ],
];

const LEFT = 200;
const RIGHT = 936;
const GAP = 16;
const pitch = (RIGHT - LEFT + GAP) / columns.length;
const width = pitch - GAP;
const x = (index: number): number => LEFT + index * pitch;

/** The cutoff diagram: one column for each moment of the example. */
export const retentionWindow = {
  slug: "retention-window",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(
      24,
      40,
      [
        ["event window", 12, "ink", SANS, 600],
        ["14 days · pass at 03:00 UTC", 9, "muted", MONO, 400],
      ],
      "start",
    );
    columns.forEach((column, index) => {
      d.rows(x(index) + width / 2, 44, [[column, 8, "soft", MONO, 400]]);
    });
    d.divider(LEFT, RIGHT, 52);
    rows.forEach(([name, cells], row) => {
      const y = 72 + row * 56;
      d.text(24, y + 25, name, { size: 10, color: "ink" });
      cells.forEach((cell, index) => {
        if (cell) d.box(x(index), y, width, 40, cell[0], cell[1], cell[2], 11);
      });
    });
    d.rows(
      24,
      208,
      [
        [
          "The event stays for about 14 days and 17 hours. Workhorse always keeps data a little longer than its window.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 224, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["day 1", "store", "the event is written", "10:00 · day-1 partition"],
  ["day 15", "backend", "the pass keeps day 1", "03:00 · cutoff: start of day 1"],
  ["day 15", "external", "the event is 14 days old", "10:00 · not deleted yet"],
  ["day 16", "focal", "the pass drops day 1", "03:00 · cutoff: start of day 2"],
];

/** The cutoff diagram for screens up to 600 px wide: one moment on each line. */
export const retentionWindowNarrow = {
  slug: "retention-window-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const rowPitch = 56;
    events.forEach(([label, kind, name, sub], index) => {
      const top = 24 + index * rowPitch;
      if (index > 0) d.arrow(`M 248,${top - 14} V ${top - 2}`);
      d.text(24, top + 25, label, { color: "ink" });
      d.box(112, top, 264, 42, kind, name, sub, 11);
    });
    const footerY = 24 + events.length * rowPitch + 8;
    d.rows(
      24,
      footerY,
      [
        ["The event stays for about 14 days and", 9, "muted", MONO, 400],
        ["17 hours. A window is a minimum.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
