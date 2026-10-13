import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The two diagrams of `docs/guides/030-delivery-guarantees.md`. They use the names of that guide.
 *
 * The crash: the `send-welcome-email` task of "Expect a second run after a crash". Worker A sends
 * the email at 1 s, and its process stops at 2 s, before the completion. With the default lease of
 * 30 s and no heartbeat after the stop, the lease expires at about 30 s. A tick makes the task ready,
 * and worker B runs the handler again, so the provider sends a second email.
 *
 * The checkpoints: the `invoice.send` handler of "Skip completed code with a checkpoint". Attempt 1
 * stores `charge`, and `renderInvoice` throws, so nothing is stored under `invoice`. Attempt 2 reads
 * `charge`, stores `invoice`, and calls `sendEmail`, which has no checkpoint.
 *
 * Check each fact against its source before you change a label.
 */

const crashTitle = "A crash after the email and before the completion sends the email two times";
const crashDescription =
  "Worker A claims the task, and the mail provider sends the email at 1 s. At 2 s, the process of " +
  "worker A stops before it records the completion. At about 30 s, the lease expires and the task " +
  "is ready again. Worker B claims the task and runs the handler again, so the provider sends a " +
  "second email.";

/** Column `index` of five on the crash timeline. */
const col = (index: number): number => 200 + index * 147;
const colWidth = 139;

export const deliveryCrash = {
  slug: "delivery-crash",
  title: crashTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);

    d.arrow(`M ${col(0) + 24},164 V 124`);
    d.arrow(`M ${col(1) + colWidth / 2},204 V 312`);
    d.arrow(`M ${col(4) + 24},240 V 124`);
    d.arrow(`M ${col(4) + colWidth / 2},280 V 312`);

    ["0 s", "1 s", "2 s", "about 30 s", "soon after"].forEach((time, index) => {
      d.rows(col(index) + colWidth / 2, 44, [[time, 8, "soft", MONO, 400]]);
    });
    d.divider(col(0), 936, 52);

    d.text(24, 104, "runtime row", { size: 10, color: "ink" });
    d.text(24, 188, "worker A", { size: 10, color: "ink" });
    d.text(24, 264, "worker B", { size: 10, color: "ink" });
    d.text(24, 340, "mail provider", { size: 10, color: "ink" });

    d.box(col(0), 80, col(3) - 8 - col(0), 40, "store", "owner A · active", "lease until 30 s", 11);
    d.box(col(3), 80, colWidth, 40, "store", "ready", "lease expired", 11);
    d.box(col(4), 80, colWidth, 40, "store", "owner B · active", undefined, 11);

    d.box(col(0), 164, col(2) - 8 - col(0), 40, "backend", "runs the handler", "attempt 1", 11);
    d.box(col(2), 164, colWidth, 40, "external", "process stops", "no completion", 11);

    d.box(col(4), 240, colWidth, 40, "backend", "runs the handler", "attempt 2", 11);

    d.box(col(1), 316, colWidth, 40, "backend", "email 1 sent", undefined, 11);
    d.box(col(4), 316, colWidth, 40, "focal", "email 2 sent", "a duplicate", 11);

    d.label(col(0) + 24, 136, "CLAIM");
    d.label(col(1) + colWidth / 2, 252, "SEND");
    d.label(col(4) + 24, 212, "CLAIM");
    d.label(col(4) + colWidth / 2 + 36, 288, "SEND");

    d.rows(
      24,
      392,
      [
        [
          "The handler ran two times. Write it so that a second run causes no damage.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );

    return d.render(this.slug, 960, 408, crashTitle, crashDescription);
  },
};

type Kind = "focal" | "backend" | "store" | "external";

const crashEvents: readonly (readonly [time: string, kind: Kind, name: string, sub: string])[] = [
  ["0 s", "backend", "worker A claims", "runtime row: owner A"],
  ["1 s", "backend", "worker A sends the email", "email 1 sent"],
  ["2 s", "external", "worker A stops", "no completion"],
  ["about 30 s", "store", "the lease expires", "the task is ready again"],
  ["soon after", "backend", "worker B claims", "runs the handler again"],
  ["soon after", "focal", "worker B sends the email", "email 2 sent · a duplicate"],
];

/** The crash diagram for screens up to 600 px wide: one event on each line, in time order. */
export const deliveryCrashNarrow = {
  slug: "delivery-crash-narrow",
  title: crashTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const pitch = 56;

    crashEvents.forEach(([time, kind, name, sub], index) => {
      const top = 24 + index * pitch;
      if (index > 0) d.arrow(`M 240,${top - 14} V ${top - 2}`);
      d.text(24, top + 25, time, { color: "ink" });
      d.box(104, top, 272, 42, kind, name, sub, 11);
    });

    const footerY = 24 + crashEvents.length * pitch + 8;
    d.rows(
      24,
      footerY,
      [
        ["The handler ran two times. Write it so", 9, "muted", MONO, 400],
        ["that a second run causes no damage.", 9, "muted", MONO, 400],
      ],
      "start",
    );

    return d.render(this.slug, 400, footerY + 32, crashTitle, crashDescription);
  },
};

const checkpointTitle = "A checkpoint stores a result, and a later attempt reads it";
const checkpointDescription =
  "In attempt 1, the charge checkpoint charges the card and Workhorse stores the result. Then " +
  "renderInvoice throws, and Workhorse schedules a retry. In attempt 2, the charge checkpoint " +
  "returns the stored value, the invoice checkpoint runs and is stored, and sendEmail runs.";

type Step = readonly [kind: Kind, name: string, sub: string];

/** The top of row `index` in the wide checkpoint diagram. */
const rowY = (index: number): number => 80 + index * 64;

const attempt1: readonly Step[] = [
  ["backend", "charge", "runs · charges the card"],
  ["external", "invoice", "renderInvoice throws"],
  ["external", "sendEmail", "not reached"],
];
const attempt2: readonly Step[] = [
  ["focal", "charge", "returns the stored value"],
  ["backend", "invoice", "runs · result stored"],
  ["backend", "sendEmail", "runs · no checkpoint"],
];

export const deliveryCheckpoints = {
  slug: "delivery-checkpoints",
  title: checkpointTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);

    d.arrow(`M 304,${rowY(0) + 22} H 362`);
    d.arrow(`M 594,${rowY(0) + 22} H 652`);
    d.arrow(`M 656,${rowY(1) + 22} H 598`);

    const heading = (x: number, title: string, note: string): void => {
      d.rows(
        x,
        44,
        [
          [title, 12, "ink", SANS, 600],
          [note, 9, "muted", MONO, 400],
        ],
        "start",
      );
    };
    heading(24, "Attempt 1", "renderInvoice fails one time");
    heading(366, "task_checkpoint", "one row for each stored name");
    heading(656, "Attempt 2", "the handler starts from the top");

    attempt1.forEach(([kind, name, sub], index) =>
      d.box(24, rowY(index), 280, 44, kind, name, sub, 11),
    );
    d.box(366, rowY(0), 224, 44, "store", "charge", "stored in attempt 1", 11);
    d.box(366, rowY(1), 224, 44, "store", "invoice", "stored in attempt 2", 11);
    attempt2.forEach(([kind, name, sub], index) =>
      d.box(656, rowY(index), 280, 44, kind, name, sub, 11),
    );

    d.label(334, rowY(0) + 4, "STORE");
    d.label(624, rowY(0) + 4, "READ");
    d.label(626, rowY(1) + 4, "STORE");

    d.rows(
      24,
      300,
      [
        [
          "sendEmail has no checkpoint. It can run again, so give it a provider idempotency key.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );

    return d.render(this.slug, 960, 316, checkpointTitle, checkpointDescription);
  },
};

/** The checkpoint diagram for screens up to 600 px wide: attempt 1, the table, and attempt 2. */
export const deliveryCheckpointsNarrow = {
  slug: "delivery-checkpoints-narrow",
  title: checkpointTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const sections: readonly (readonly [title: string, note: string, steps: readonly Step[]])[] = [
      ["Attempt 1", "renderInvoice fails one time", attempt1],
      [
        "task_checkpoint",
        "one row for each stored name",
        [
          ["store", "charge", "stored in attempt 1"],
          ["store", "invoice", "stored in attempt 2"],
        ],
      ],
      ["Attempt 2", "the handler starts from the top", attempt2],
    ];

    let y = 36;
    sections.forEach(([title, note, steps], index) => {
      if (index > 0) {
        d.arrow(`M 200,${y - 36} V ${y - 18}`);
        d.label(200 + 60, y - 34, index === 1 ? "STORE CHARGE" : "READ CHARGE");
      }
      d.rows(
        24,
        y,
        [
          [title, 12, "ink", SANS, 600],
          [note, 9, "muted", MONO, 400],
        ],
        "start",
      );
      steps.forEach(([kind, name, sub], row) =>
        d.box(24, y + 28 + row * 52, 352, 42, kind, name, sub, 11),
      );
      y += 28 + steps.length * 52 + 48;
    });

    const footerY = y - 20;
    d.rows(
      24,
      footerY,
      [
        ["sendEmail has no checkpoint. It can run", 9, "muted", MONO, 400],
        ["again, so give it a provider idempotency key.", 9, "muted", MONO, 400],
      ],
      "start",
    );

    return d.render(this.slug, 400, footerY + 32, checkpointTitle, checkpointDescription);
  },
};
