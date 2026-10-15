import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `site/content/docs/migrate.mdx`. It uses the names of that page.
 *
 * "Move one task type at a time": a Workhorse handler and a worker come first, and the worker
 * waits until tasks arrive. Then the producers enqueue inside the transaction that writes their
 * data, and the old worker finishes the tasks that are already in the old queue. Both workers run
 * until the old queue is empty. Then the old task code and the old producer code go.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";
type Cell = readonly [kind: Kind, name: string, sub: string] | undefined;

const columns = [192, 444, 696] as const;
const WIDTH = 240;

const title = "Move one task type: both workers run until the old queue is empty";
const description =
  "Steps 1 and 2: write a Workhorse handler and deploy a worker that waits for tasks, while the " +
  "producers still publish to the old system. Steps 3 to 5: the producers enqueue inside the " +
  "transaction that writes their data, and the old worker finishes the old queue. Step 6: when " +
  "the old queue is empty, remove the old task code and the old producer code.";

const rows: readonly (readonly [label: readonly [string, string], cells: readonly Cell[]])[] = [
  [
    ["producers", "code that enqueues"],
    [
      ["external", "publish after the commit", "the old system"],
      ["focal", "enqueue in the transaction", "Workhorse"],
      ["backend", "enqueue in the transaction", "Workhorse"],
    ],
  ],
  [
    ["old worker", "the old system"],
    [
      ["external", "runs the task type", "the old queue"],
      ["external", "finishes the old queue", "keep it running"],
      undefined,
    ],
  ],
  [
    ["Workhorse", "the worker"],
    [
      ["backend", "waits for tasks", "the same payload shape"],
      ["store", "runs the new tasks", "beside the old worker"],
      ["store", "runs the task type", "the only worker"],
    ],
  ],
];

/** The move diagram: each row is one part, and each column is one period of the move. */
export const migrateTaskType = {
  slug: "migrate-task-type",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    ["steps 1 – 2 · prepare", "steps 3 – 5 · switch and empty", "step 6 · remove"].forEach(
      (heading, index) => {
        d.rows(columns[index]! + WIDTH / 2, 44, [[heading, 9, "ink", MONO, 400]]);
      },
    );
    d.divider(192, 936, 56);
    rows.forEach(([label, cells], index) => {
      const y = 72 + index * 64;
      d.rows(
        24,
        y + 18,
        [
          [label[0], 12, "ink", SANS, 600],
          [label[1], 9, "muted", MONO, 400],
        ],
        "start",
      );
      cells.forEach((cell, col) => {
        const x = columns[col]!;
        if (cell === undefined) {
          d.rows(x + WIDTH / 2, y + 28, [["removed", 9, "soft", MONO, 400]]);
          return;
        }
        d.box(x, y, WIDTH, 48, cell[0], cell[1], cell[2], 11);
      });
    });
    const footerY = 72 + rows.length * 64 + 16;
    d.rows(
      24,
      footerY,
      [
        [
          "During a rolling deploy, each request goes to one system only. Both workers run, so the tasks in both queues continue to run.",
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
  ["1 · 2", "backend", "handler and worker", "the worker waits for tasks"],
  ["3", "focal", "producers enqueue", "in the transaction"],
  ["4", "external", "old worker runs", "finishes the old queue"],
  ["5", "external", "empty the old system", "retries, delays, schedules"],
  ["6", "store", "remove the old code", "task code and producer code"],
];

/** The move diagram for screens up to 600 px wide: one step on each line. */
export const migrateTaskTypeNarrow = {
  slug: "migrate-task-type-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
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
      [
        ["Both workers run until the old queue", 9, "muted", MONO, 400],
        ["is empty.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
