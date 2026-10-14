import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/150-priority.md`. They use the names of that guide. Each column is
 * one moment, and the rows show the ready order, the event, and the task that a free slot gets.
 *
 * "Run an urgent task first": queue `billing` has fifty ordinary reminders ready at the default
 * priority. At 2 s an urgent reminder becomes ready. The claim orders ready tasks by priority, then
 * in FIFO order, so the slot that becomes free at 3 s gets the urgent reminder, and the slot at 4 s
 * gets the oldest ordinary reminder.
 *
 * "Use priority with concurrency policies and rate limits": two reminders for `cust-8` run, and the
 * concurrency policy allows two for one customer. The claim skips the urgent reminder for `cust-8`
 * and returns the ordinary reminder for `cust-9`. The skipped task stays ready and keeps its place.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";
type Cell = readonly [kind: Kind, name: string, sub: string] | undefined;

const LEFT = 200;
const RIGHT = 936;
const GAP = 16;

function grid(
  d: Diagram,
  heading: readonly [string, string],
  times: readonly string[],
  rows: readonly (readonly [name: string, cells: readonly Cell[]])[],
): number {
  const pitch = (RIGHT - LEFT + GAP) / times.length;
  const width = pitch - GAP;
  const x = (index: number): number => LEFT + index * pitch;
  d.rows(
    24,
    40,
    [
      [heading[0], 12, "ink", SANS, 600],
      [heading[1], 9, "muted", MONO, 400],
    ],
    "start",
  );
  times.forEach((time, index) => {
    d.rows(x(index) + width / 2, 44, [[time, 8, "soft", MONO, 400]]);
  });
  d.divider(LEFT, RIGHT, 52);
  rows.forEach(([name, cells], row) => {
    const y = 72 + row * 56;
    d.text(24, y + 25, name, { size: 10, color: "ink" });
    cells.forEach((cell, index) => {
      if (cell) d.box(x(index), y, width, 40, cell[0], cell[1], cell[2], 11);
    });
  });
  return 72 + rows.length * 56 + 8;
}

function footer(d: Diagram, y: number, lines: readonly string[]): number {
  d.rows(
    24,
    y,
    lines.map((line) => [line, 9, "muted", MONO, 400] as const),
    "start",
  );
  return y + 1 + lines.length * 15;
}

const orderTitle = "An urgent ready task starts before older ordinary tasks";
const orderDescription =
  "Queue billing has fifty ordinary reminders ready, and all worker slots are busy. At 2 s, the app " +
  "enqueues an urgent reminder. At 3 s, a slot becomes free, and the worker gets the urgent " +
  "reminder. At 4 s, another slot becomes free, and the worker gets the oldest ordinary reminder.";

/** The order diagram: one column for each moment of the first example. */
export const priorityOrder = {
  slug: "priority-order",
  title: orderTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = grid(
      d,
      ["billing", "all slots are busy"],
      ["0 s", "2 s", "3 s", "4 s"],
      [
        [
          "event",
          [
            ["external", "50 ordinary ready", "in FIFO order"],
            ["external", "enqueue urgent", "the reminder is ready"],
            ["external", "a slot is free", "the worker asks"],
            ["external", "a slot is free", "the worker asks"],
          ],
        ],
        [
          "ready order",
          [
            ["store", "ordinary", "oldest first"],
            ["store", "urgent first", "then the ordinary"],
            ["store", "ordinary", "oldest first"],
            ["store", "ordinary", "49 are left"],
          ],
        ],
        [
          "worker gets",
          [
            undefined,
            undefined,
            ["focal", "the urgent reminder", "not the oldest"],
            ["backend", "the oldest ordinary", "no urgent is ready"],
          ],
        ],
      ],
    );
    const height = footer(d, y + 16, [
      "The highest priority starts first. Tasks with the same priority keep their FIFO order.",
    ]);
    return d.render(this.slug, 960, height, orderTitle, orderDescription);
  },
};

function eventList(
  d: Diagram,
  events: readonly (readonly [time: string, kind: Kind, name: string, sub: string])[],
  lines: readonly string[],
): number {
  const pitch = 56;
  events.forEach(([time, kind, name, sub], index) => {
    const top = 24 + index * pitch;
    if (index > 0) d.arrow(`M 248,${top - 14} V ${top - 2}`);
    d.text(24, top + 25, time, { color: "ink" });
    d.box(112, top, 264, 42, kind, name, sub, 11);
  });
  return footer(d, 24 + events.length * pitch + 8, lines) + 16;
}

/** The order diagram for screens up to 600 px wide: one event on each line. */
export const priorityOrderNarrow = {
  slug: "priority-order-narrow",
  title: orderTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["0 s", "store", "50 ordinary ready", "all slots are busy"],
        ["2 s", "external", "enqueue urgent", "it is first in the order"],
        ["3 s", "focal", "a slot gets the urgent", "not the oldest ordinary"],
        ["4 s", "backend", "a slot gets the oldest", "no urgent is ready"],
      ],
      ["The highest priority starts first. Tasks", "with the same priority keep FIFO order."],
    );
    return d.render(this.slug, 400, height, orderTitle, orderDescription);
  },
};

const admissionTitle = "Priority orders only the tasks that the admission rules let start";
const admissionDescription =
  "Queue billing lets two tasks for one customer run at the same time, and two reminders for " +
  "cust-8 run. At 0 s, an urgent reminder for cust-8 and an ordinary reminder for cust-9 are " +
  "ready. At 1 s, cust-8 has no free capacity, so Workhorse skips the urgent reminder, and the " +
  "worker gets the reminder for cust-9. At 20 s, a cust-8 reminder completes, and the next worker " +
  "gets the urgent reminder.";

/** The admission diagram: one column for each moment of the concurrency example. */
export const priorityAdmission = {
  slug: "priority-admission",
  title: admissionTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = grid(
      d,
      ["billing", "2 tasks per customer"],
      ["0 s", "1 s", "20 s"],
      [
        [
          "ready order",
          [
            ["store", "urgent cust-8", "then ordinary cust-9"],
            ["store", "urgent cust-8", "stays ready · keeps its place"],
            ["store", "urgent cust-8", "first in the order"],
          ],
        ],
        [
          "cust-8",
          [
            ["external", "2 reminders run", "no free capacity"],
            ["external", "2 reminders run", "Workhorse skips urgent cust-8"],
            ["external", "1 reminder completes", "capacity is free"],
          ],
        ],
        [
          "worker gets",
          [
            undefined,
            ["backend", "ordinary cust-9", "the first task that can start"],
            ["focal", "urgent cust-8", "the next worker gets it"],
          ],
        ],
      ],
    );
    const height = footer(d, y + 16, [
      "An admission rule can hold back an urgent task. The task stays ready and keeps its place.",
    ]);
    return d.render(this.slug, 960, height, admissionTitle, admissionDescription);
  },
};

/** The admission diagram for screens up to 600 px wide: one event on each line. */
export const priorityAdmissionNarrow = {
  slug: "priority-admission-narrow",
  title: admissionTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["0 s", "store", "urgent cust-8 is ready", "2 cust-8 reminders run"],
        ["1 s", "external", "cust-8: no capacity", "Workhorse skips urgent cust-8"],
        ["1 s", "backend", "a worker gets cust-9", "the ordinary reminder"],
        ["20 s", "focal", "a worker gets cust-8", "a cust-8 reminder completed"],
      ],
      ["An admission rule can hold back an urgent", "task. It stays ready and keeps its place."],
    );
    return d.render(this.slug, 400, height, admissionTitle, admissionDescription);
  },
};
