import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `docs/guides/220-schedules.md`. It uses the names of that guide.
 *
 * "Choose what happens after a gap": `invoice-run` is due each night at 02:00. Every worker that
 * offers `billing-production` stops on Monday at 01:30 and starts again on Thursday at 09:00, so
 * the occurrences from Monday to Thursday are missed. `skip` fires none of them, `latest` fires one
 * task for Thursday at 02:00, and `all` fires one task for each missed occurrence. Every policy
 * fires Friday at 02:00 normally. A catch-up task is created when a worker evaluates the
 * namespace again, so it is created after the restart, not at its occurrence time.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";
type Cell = readonly [kind: Kind, name: string, sub: string] | undefined;

const title = "After a gap, the catch-up policy decides which missed occurrences fire";
const description =
  "invoice-run is due each night at 02:00. Every worker that offers billing-production stops on " +
  "Monday at 01:30 and starts again on Thursday at 09:00, so four occurrences are missed. With " +
  "skip, none of them fires. With latest, one task fires, for Thursday at 02:00. With all, four " +
  "tasks fire. Each policy fires Friday at 02:00 normally.";

const nights = ["Mon 02:00", "Tue 02:00", "Wed 02:00", "Thu 02:00", "Fri 02:00"] as const;

const LEFT = 200;
const RIGHT = 936;
const GAP = 12;
const pitch = (RIGHT - LEFT + GAP) / nights.length;
const width = pitch - GAP;
const x = (index: number): number => LEFT + index * pitch;

const missed: Cell = ["store", "a task", "after the restart"];
const onTime: Cell = ["backend", "a task", "on time"];

const policies: readonly (readonly [name: string, cells: readonly Cell[]])[] = [
  ["skip", [undefined, undefined, undefined, undefined, onTime]],
  ["latest", [undefined, undefined, undefined, ["focal", "a task", "after the restart"], onTime]],
  ["all", [missed, missed, missed, missed, onTime]],
];

/** The catch-up diagram: one column for each night and one row for each policy. */
export const scheduleCatchup = {
  slug: "schedules-catchup",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(
      24,
      40,
      [
        ["invoice-run", 12, "ink", SANS, 600],
        ["0 2 * * *", 9, "muted", MONO, 400],
      ],
      "start",
    );
    nights.forEach((night, index) => {
      d.rows(x(index) + width / 2, 44, [[night, 8, "soft", MONO, 400]]);
    });
    d.divider(LEFT, RIGHT, 52);

    d.text(24, 97, "workers", { size: 10, color: "ink" });
    d.box(
      x(0),
      72,
      x(3) + width - x(0),
      40,
      "external",
      "every worker stopped",
      "Mon 01:30 to Thu 09:00 · 4 occurrences missed",
      11,
    );
    d.box(x(4), 72, width, 40, "backend", "running", "since Thu 09:00", 11);

    policies.forEach(([name, cells], row) => {
      const y = 136 + row * 56;
      d.text(24, y + 25, name, { size: 10, color: "ink" });
      cells.forEach((cell, index) => {
        if (cell === undefined) {
          d.rows(x(index) + width / 2, y + 24, [["not fired", 8, "soft", MONO, 400]]);
          return;
        }
        d.box(x(index), y, width, 40, cell[0], cell[1], cell[2], 11);
      });
    });

    const footerY = 136 + policies.length * 56 + 24;
    d.rows(
      24,
      footerY,
      [
        [
          "By default, Workhorse skips missed occurrences, so an outage does not make a backlog of tasks.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, footerY + 16, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["gap", "external", "every worker stopped", "Mon to Thu · 4 occurrences missed"],
  ["skip", "backend", "no catch-up task", "next task: Fri 02:00"],
  ["latest", "focal", "one task", "for Thu 02:00"],
  ["all", "store", "four tasks", "one for each missed occurrence"],
];

/** The catch-up diagram for screens up to 600 px wide: one policy on each line. */
export const scheduleCatchupNarrow = {
  slug: "schedules-catchup-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const rowPitch = 56;
    events.forEach(([label, kind, name, sub], index) => {
      const top = 24 + index * rowPitch;
      d.text(24, top + 25, label, { color: "ink" });
      d.box(112, top, 264, 42, kind, name, sub, 11);
    });
    const footerY = 24 + events.length * rowPitch + 8;
    d.rows(
      24,
      footerY,
      [
        ["By default, Workhorse skips missed", 9, "muted", MONO, 400],
        ["occurrences, so an outage makes no backlog.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
