import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `site/content/docs/pgcat.mdx`. It uses the names of that page.
 *
 * "Give the worker a direct pool to keep wake hints": the worker sends `LISTEN workhorse_tasks`
 * through PgCat, and PgCat accepts it without an error. The worker waits and sends no query. A task
 * is enqueued, and PostgreSQL sends a notification. PgCat buffers it until the client sends a
 * different query. The fallback poll of the worker is that query: it finds the task, and the
 * buffered notification arrives with its result.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const title = "PgCat holds the wake hint until the idle worker sends a query";
const description =
  "The worker sends LISTEN workhorse_tasks through PgCat, and no error occurs. The worker waits " +
  "and sends no query. A task is enqueued, and PostgreSQL sends a notification. PgCat buffers it " +
  "until the next query of the worker. The fallback poll of the worker finds the task, and the " +
  "buffered notification arrives only with the result of that poll.";

const lanes = ["the worker", "PgCat", "PostgreSQL"] as const;
const LANE = [200, 456, 712] as const;
const WIDTH = 224;

type Cell = readonly [kind: Kind, name: string, sub: string] | undefined;

const steps: readonly (readonly [
  label: readonly [string, string],
  cells: readonly Cell[],
  arrow: "right" | "left" | undefined,
])[] = [
  [
    ["1 · listen", "pool mode does not matter"],
    [
      ["backend", "LISTEN workhorse_tasks", "through PgCat"],
      ["store", "accepts it", "no error"],
      undefined,
    ],
    "right",
  ],
  [
    ["2 · wait", "the queue is empty"],
    [["store", "waits", "sends no query"], undefined, undefined],
    undefined,
  ],
  [
    ["3 · enqueue", "your application"],
    [
      undefined,
      ["external", "buffers the hint", "until the next query"],
      ["backend", "notification", "a task is enqueued"],
    ],
    "left",
  ],
  [
    ["4 · poll", "the fallback poll"],
    [
      ["focal", "sends the poll query", "and claims the task"],
      ["store", "relays the hint", "with the poll result"],
      undefined,
    ],
    "right",
  ],
];

/** The wake hint diagram: one lane for each party, one row for each step. */
export const pgcatWakeHint = {
  slug: "pgcat-wake-hint",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    lanes.forEach((lane, index) => {
      d.rows(LANE[index]! + WIDTH / 2, 44, [[lane, 8, "soft", MONO, 400]]);
    });
    d.divider(LANE[0], LANE[2] + WIDTH, 52);
    steps.forEach(([label, cells, arrow], index) => {
      const y = 72 + index * 64;
      d.rows(
        24,
        y + 18,
        [
          [label[0], 11, "ink", SANS, 600],
          [label[1], 9, "muted", MONO, 400],
        ],
        "start",
      );
      const filled = cells.flatMap((cell, lane) => (cell ? [lane] : []));
      if (arrow && filled.length === 2) {
        const [from, to] = arrow === "right" ? [filled[0]!, filled[1]!] : [filled[1]!, filled[0]!];
        const fromX = arrow === "right" ? LANE[from]! + WIDTH : LANE[from]!;
        const toX = arrow === "right" ? LANE[to]! - 2 : LANE[to]! + WIDTH + 2;
        d.arrow(`M ${fromX},${y + 24} H ${toX}`);
      }
      cells.forEach((cell, lane) => {
        if (cell) d.box(LANE[lane]!, y, WIDTH, 48, cell[0], cell[1], cell[2], 11);
      });
    });
    const footerY = 72 + steps.length * 64 + 16;
    d.rows(
      24,
      footerY,
      [
        [
          "Every task still runs. To keep wake hints, give the worker a direct pool or session-mode PgBouncer.",
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
  ["listen", "backend", "LISTEN through PgCat", "accepted · no error"],
  ["wait", "store", "the worker waits", "it sends no query"],
  ["enqueue", "external", "PgCat buffers the hint", "until the next query"],
  ["poll", "focal", "the fallback poll", "claims the task"],
];

/** The wake hint diagram for screens up to 600 px wide: one step on each line. */
export const pgcatWakeHintNarrow = {
  slug: "pgcat-wake-hint-narrow",
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
        ["Every task still runs. Only the", 9, "muted", MONO, 400],
        ["wake-up is slower.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
