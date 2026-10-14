import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `docs/guides/335-cold-export.md`. It uses the names of that guide.
 *
 * "Export one UTC day at a time": a day is ready for export only after it ends and the statistics
 * rollup passes it. The exporter `archiver-1` copies one segment, one day of one history table, as
 * a compressed file of JSON lines with a manifest, and then marks the segment complete. The rollup
 * watermark and the export watermark both gate retention, so the export always comes before the
 * deletion. The export store keeps the day.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";
type Cell = readonly [kind: Kind, name: string, sub: string] | undefined;

const title = "Cold export copies a finished day before retention deletes it";
const description =
  "During 14 September UTC, tasks write events and attempts. At midnight the day ends, but the " +
  "rollup has not summarized it, so it is not ready. Some minutes later the rollup passes midnight, " +
  "and the day is ready. At its next run, archiver-1 writes the file and its manifest to the export " +
  "store and marks the segment complete. When the retention window ends, retention deletes the day " +
  "from PostgreSQL. The export store keeps it.";

const columns = ["14 Sep", "midnight UTC", "minutes later", "next run", "window ends"] as const;

const rows: readonly (readonly [name: string, cells: readonly Cell[]])[] = [
  [
    "PostgreSQL",
    [
      ["store", "history written", "task_event rows"],
      ["external", "day ended", "not ready"],
      ["store", "rollup passed", "ready for export"],
      ["store", "segment complete", "export watermark moves"],
      ["backend", "retention deletes", "the day"],
    ],
  ],
  [
    "export store",
    [
      undefined,
      undefined,
      undefined,
      ["focal", "file + manifest", "written by archiver-1"],
      ["focal", "keeps the day", "for the auditor"],
    ],
  ],
];

const LEFT = 200;
const RIGHT = 936;
const GAP = 12;
const pitch = (RIGHT - LEFT + GAP) / columns.length;
const width = pitch - GAP;
const x = (index: number): number => LEFT + index * pitch;

/** The day diagram: one column for each moment, one row for each place that holds the day. */
export const coldExportDay = {
  slug: "cold-export-day",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(
      24,
      40,
      [
        ["task_event", 12, "ink", SANS, 600],
        ["one segment · 14 Sep", 9, "muted", MONO, 400],
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
          "Workhorse permits the export only after the rollup passes the day, so the export comes before the deletion.",
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
  ["14 Sep", "store", "history written", "task_event rows"],
  ["00:00", "external", "the day ends", "not ready for export"],
  ["later", "store", "the rollup passes the day", "ready for export"],
  ["run", "focal", "archiver-1 exports it", "file + manifest · segment complete"],
  ["window", "backend", "retention deletes the day", "the export store keeps it"],
];

/** The day diagram for screens up to 600 px wide: one moment on each line. */
export const coldExportDayNarrow = {
  slug: "cold-export-day-narrow",
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
        ["The export always comes before the", 9, "muted", MONO, 400],
        ["deletion.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
