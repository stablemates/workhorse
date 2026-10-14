import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `docs/guides/200-transactional-enqueue.md`. It uses the names of that guide.
 *
 * "Enqueue a task in your transaction" and "Roll back the task with your data": the app server
 * inserts the row for `acc-7` and enqueues `account.created` in one transaction. The task is a row
 * in the same database, so a commit makes both visible at the same time, and a rollback discards
 * both. With two separate commits, the account can commit and the process can stop before the
 * enqueue, so no task sends the email. Workhorse does not commit or roll back the transaction.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";
type Cell = readonly [kind: Kind, name: string, sub: string];

const title = "One transaction keeps the account and its task together";
const description =
  "The app server inserts the row for acc-7 and enqueues account.created. In one transaction with " +
  "COMMIT, both become visible at the same time, and a worker sends the email. In one transaction " +
  "with ROLLBACK, PostgreSQL discards both, and no worker sees the task. With two separate " +
  "commits, the account commits, the process stops before the enqueue, and no task sends the email.";

const columns: readonly (readonly [heading: string, sub: string])[] = [
  ["one transaction", "COMMIT"],
  ["one transaction", "ROLLBACK"],
  ["two separate commits", "the process stops"],
];

const rows: readonly (readonly [name: string, cells: readonly Cell[]])[] = [
  [
    "acc-7 row",
    [
      ["store", "committed", "visible with the task"],
      ["external", "discarded", "by the rollback"],
      ["store", "committed", "the first commit"],
    ],
  ],
  [
    "account.created",
    [
      ["store", "committed", "visible with the row"],
      ["external", "discarded", "together with the row"],
      ["external", "never enqueued", "the process stopped"],
    ],
  ],
  [
    "worker",
    [
      ["backend", "claims the task", "sends the email"],
      ["backend", "sees no task", "no account, no email"],
      ["focal", "sees no task", "acc-7 gets no email"],
    ],
  ],
];

const LEFT = 200;
const RIGHT = 936;
const GAP = 16;
const pitch = (RIGHT - LEFT + GAP) / columns.length;
const width = pitch - GAP;
const x = (index: number): number => LEFT + index * pitch;

/** The outcome diagram: one column for each case, with the same rows. */
export const enqueueOutcomes = {
  slug: "enqueue-outcomes",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    columns.forEach(([heading, sub], index) => {
      d.rows(x(index) + width / 2, 36, [
        [heading, 11, "ink", SANS, 600],
        [sub, 8, "soft", MONO, 400],
      ]);
    });
    d.divider(LEFT, RIGHT, 60);
    rows.forEach(([name, cells], row) => {
      const y = 80 + row * 56;
      d.text(24, y + 25, name, { size: 10, color: "ink" });
      cells.forEach(([kind, label, sub], index) => {
        d.box(x(index), y, width, 40, kind, label, sub, 11);
      });
    });
    const footerY = 80 + rows.length * 56 + 24;
    d.rows(
      24,
      footerY,
      [
        [
          "In one transaction, PostgreSQL commits the row and the task together, or rolls back both.",
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
  ["COMMIT", "backend", "row and task committed", "a worker sends the email"],
  ["ROLLBACK", "external", "row and task discarded", "no worker sees the task"],
  ["2 commits", "focal", "row committed, no task", "acc-7 gets no email"],
];

/** The outcome diagram for screens up to 600 px wide: one case on each line. */
export const enqueueOutcomesNarrow = {
  slug: "enqueue-outcomes-narrow",
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
        ["In one transaction, PostgreSQL commits the", 9, "muted", MONO, 400],
        ["row and the task together, or rolls back", 9, "muted", MONO, 400],
        ["both.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 48, title, description);
  },
};
