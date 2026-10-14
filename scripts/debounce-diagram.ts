import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/215-debounce.md`. They use the names of that guide. Both draw the
 * same time axis from 0 s to 5 s, with one row for each revision of `doc-42`, so the reader can
 * compare the two schedules.
 *
 * "Replace a pending task while updates arrive": with `schedule: "reset"` and a window of 2 s,
 * each replacement puts the new payload in the pending task and moves its run time to the request
 * time plus the window. Revisions arrive at 0 s, 1 s, and 2.5 s, so the run time moves to 2 s, 3 s,
 * and 4.5 s. Every request gets the same `taskId`.
 *
 * "Choose to reset or preserve the run time": with `schedule: "preserve"`, the first request sets
 * the run time, and a later request replaces only the payload.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const AXIS_LEFT = 240;
const SECOND = 112;
const at = (seconds: number): number => AXIS_LEFT + seconds * SECOND;

type Row = readonly [
  label: string,
  outcome: string,
  start: number,
  end: number,
  kind: Kind,
  name: string,
  sub: string,
];

function timeline(
  d: Diagram,
  schedule: string,
  rows: readonly Row[],
  run: readonly [seconds: number, name: string, sub: string],
  note: string,
): number {
  d.rows(
    24,
    40,
    [
      ["doc-42", 12, "ink", SANS, 600],
      [schedule, 9, "muted", MONO, 400],
    ],
    "start",
  );
  for (let second = 0; second <= 5; second += 1) {
    d.rows(at(second), 44, [[`${second} s`, 8, "soft", MONO, 400]]);
  }
  d.divider(at(0), at(5), 52);

  rows.forEach(([label, outcome, start, end, kind, name, sub], index) => {
    const y = 72 + index * 56;
    d.rows(
      24,
      y + 16,
      [
        [label, 11, "ink", SANS, 600],
        [outcome, 9, "muted", MONO, 400],
      ],
      "start",
    );
    d.box(at(start), y, at(end) - at(start), 40, kind, name, sub, 11);
  });

  const last = rows.length - 1;
  const runY = 72 + last * 56;
  d.box(at(run[0]) + 8, runY, 132, 40, "focal", run[1], run[2], 11);

  const footerY = 72 + rows.length * 56 + 24;
  d.rows(24, footerY, [[note, 9, "muted", MONO, 400]], "start");
  return footerY + 16;
}

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

const resetTitle = "With reset, each new revision moves the run time";
const resetDescription =
  "Requests for doc-42 use a window of 2 s and schedule reset. Revision 1 at 0 s creates a task " +
  "that runs at 2 s. Revision 2 at 1 s replaces the payload and moves the run time to 3 s. " +
  "Revision 3 at 2.5 s moves it to 4.5 s. Soon after 4.5 s, a worker indexes revision 3. Every " +
  "request gets the same taskId.";

/** The reset timeline: each bar is the window that one request starts. */
export const debounceReset = {
  slug: "debounce-reset",
  title: resetTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = timeline(
      d,
      'schedule: "reset"',
      [
        ["revision 1", "accepted", 0, 2, "external", "run time 2 s", "replaced at 1 s"],
        ["revision 2", "replaced", 1, 3, "external", "run time 3 s", "replaced at 2.5 s"],
        ["revision 3", "replaced", 2.5, 4.5, "store", "run time 4.5 s", "no later request"],
      ],
      [4.5, "runs", "indexes revision 3"],
      "Three requests make one task with one taskId. The task uses the latest revision.",
    );
    return d.render(this.slug, 960, height, resetTitle, resetDescription);
  },
};

/** The reset timeline for screens up to 600 px wide: one request on each line. */
export const debounceResetNarrow = {
  slug: "debounce-reset-narrow",
  title: resetTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["0 s", "store", "revision 1: accepted", "the task runs at 2 s"],
        ["1 s", "store", "revision 2: replaced", "the run time moves to 3 s"],
        ["2.5 s", "store", "revision 3: replaced", "the run time moves to 4.5 s"],
        ["4.5 s", "focal", "the task runs", "indexes revision 3"],
      ],
      ["Three requests make one task with one", "taskId. It uses the latest revision."],
    );
    return d.render(this.slug, 400, height, resetTitle, resetDescription);
  },
};

const preserveTitle = "With preserve, the first request sets the run time";
const preserveDescription =
  "Requests for doc-42 use a window of 2 s and schedule preserve. Revision 1 at 0 s creates a " +
  "task that runs at 2 s. Revision 2 at 1 s replaces the payload, and the run time stays at 2 s. " +
  "Soon after 2 s, a worker indexes revision 2.";

/** The preserve timeline, on the same axis as the reset timeline. */
export const debouncePreserve = {
  slug: "debounce-preserve",
  title: preserveTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = timeline(
      d,
      'schedule: "preserve"',
      [
        ["revision 1", "accepted", 0, 2, "external", "run time 2 s", "set by revision 1"],
        ["revision 2", "replaced", 1, 2, "store", "stays 2 s", "new payload"],
      ],
      [2, "runs", "indexes revision 2"],
      "Later requests replace only the payload. The task runs by a known time.",
    );
    return d.render(this.slug, 960, height, preserveTitle, preserveDescription);
  },
};

/** The preserve timeline for screens up to 600 px wide: one request on each line. */
export const debouncePreserveNarrow = {
  slug: "debounce-preserve-narrow",
  title: preserveTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["0 s", "store", "revision 1: accepted", "the task runs at 2 s"],
        ["1 s", "store", "revision 2: replaced", "the run time stays at 2 s"],
        ["2 s", "focal", "the task runs", "indexes revision 2"],
      ],
      ["Later requests replace only the payload.", "The task runs by a known time."],
    );
    return d.render(this.slug, 400, height, preserveTitle, preserveDescription);
  },
};
