import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/135-signals.md`. They use the names of that guide.
 *
 * "Wait for a signal from another process": worker A runs the handler for `ord-381`, and
 * `ctx.waitForSignal("approval")` records the wait and releases the lease. While the task is
 * parked, its runtime row is `scheduled` with no owner. At 3 h, the review service calls
 * `Queue.sendSignal`, and Workhorse stores the payload and sets the task to `ready`. Worker B runs
 * the handler from the first line, and the wait returns the stored payload at once. The wait uses
 * no attempt; the second claim gets a new fence token. The fence numbers are an illustration.
 *
 * "Deliver a signal one time": `send_signal_v1` returns `delivered` for the first accepted
 * delivery, `duplicate` with the stored payload for the same key and request, and
 * `already_delivered` with the first payload for another key. Only `delivered` resumes the task.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const waitTitle = "A signal wait frees the worker until the payload arrives";
const waitDescription =
  "At 0 s, worker A runs the handler for ord-381, and the handler waits for the approval signal. " +
  "No worker holds the task during the wait. At 3 h, the review service calls sendSignal, and " +
  "Workhorse stores the payload and sets the task to ready. Worker B runs the handler from its " +
  "first line. The wait returns the stored payload, and the handler publishes the order. Both " +
  "runs are attempt 1.";

const waitColumns = [192, 572] as const;
const WAIT_WIDTH = 364;

type WaitCell = readonly [kind: Kind, name: string, sub: string] | undefined;

function waitRun(
  d: Diagram,
  y: number,
  label: readonly [string, string, string],
  cells: readonly WaitCell[],
): void {
  d.rows(
    24,
    y + 14,
    [
      [label[0], 12, "ink", SANS, 600],
      [label[1], 9, "muted", MONO, 400],
      [label[2], 9, "muted", MONO, 400],
    ],
    "start",
  );
  cells.forEach((cell, index) => {
    const x = waitColumns[index]!;
    if (cell === undefined) {
      d.rows(x + WAIT_WIDTH / 2, y + 27, [["not reached", 9, "soft", MONO, 400]]);
      return;
    }
    d.box(x, y, WAIT_WIDTH, 48, cell[0], cell[1], cell[2], 11);
  });
}

/** The wait diagram: each row is one run of the handler, and each column is one handler line. */
export const signalsWait = {
  slug: "signals-wait",
  title: waitTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    ['ctx.waitForSignal("approval")', "publishOrder()"].forEach((line, index) => {
      d.rows(waitColumns[index]! + WAIT_WIDTH / 2, 52, [[line, 10, "ink", MONO, 400]]);
    });
    d.divider(192, 936, 68);

    waitRun(
      d,
      84,
      ["Run 1", "worker A · 0 s", "attempt 1 · fence 1"],
      [["focal", "waits", "records the wait · frees the slot"], undefined],
    );

    d.box(192, 148, 744, 40, "external");
    d.rows(564, 172, [
      [
        "no worker holds the task · scheduled, no owner · a new deployment can replace worker A",
        9,
        "muted",
        MONO,
        400,
      ],
    ]);
    d.rows(
      24,
      164,
      [
        ["the wait", 9, "muted", MONO, 400],
        ["0 s to 3 h", 9, "soft", MONO, 400],
      ],
      "start",
    );

    d.box(
      192,
      204,
      744,
      44,
      "store",
      'the review service: sendSignal("approval", { approved: true })',
      "Workhorse stores the payload · the task becomes ready",
      11,
    );
    d.rows(
      24,
      222,
      [
        ["the signal", 9, "muted", MONO, 400],
        ["3 h", 9, "soft", MONO, 400],
      ],
      "start",
    );

    waitRun(
      d,
      264,
      ["Run 2", "worker B · after 3 h", "attempt 1 · fence 2"],
      [
        ["store", "returns", "the stored payload at once"],
        ["backend", "runs", "publishes ord-381 · task succeeds"],
      ],
    );

    d.rows(
      24,
      352,
      [
        [
          "Each run starts at the first line of the handler. The wait does not use an attempt.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 368, waitTitle, waitDescription);
  },
};

const waitEvents: readonly (readonly [time: string, kind: Kind, name: string, sub: string])[] = [
  ["0 s", "focal", "worker A: waitForSignal", "records the wait · frees the slot"],
  ["0 s to 3 h", "external", "no worker holds the task", "scheduled · no owner"],
  ["3 h", "store", "review service: sendSignal", "payload stored · task ready"],
  ["after 3 h", "store", "worker B: the wait returns", "the stored payload at once"],
  ["", "backend", "publishOrder runs", "publishes ord-381 · task succeeds"],
];

/** The wait diagram for screens up to 600 px wide: one event on each line. */
export const signalsWaitNarrow = {
  slug: "signals-wait-narrow",
  title: waitTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const pitch = 56;
    waitEvents.forEach(([time, kind, name, sub], index) => {
      const top = 24 + index * pitch;
      if (index > 0) d.arrow(`M 248,${top - 14} V ${top - 2}`);
      if (time) d.text(24, top + 25, time, { color: "ink" });
      d.box(112, top, 264, 42, kind, name, sub, 11);
    });
    const footerY = 24 + waitEvents.length * pitch + 8;
    d.rows(
      24,
      footerY,
      [
        ["Each run starts at the first line of the", 9, "muted", MONO, 400],
        ["handler. The wait does not use an attempt.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, waitTitle, waitDescription);
  },
};

const title = "Workhorse accepts only the first delivery of a signal";
const description =
  "The task for ord-381 waits for the approval signal. At 3 h, the review service sends approval " +
  "with the key review-77, and Workhorse resumes the task. At 3 h + 5 s, the service sends the " +
  "same key again, and Workhorse returns duplicate. At 3 h + 1 min, a second reviewer sends the " +
  "key review-78, and Workhorse returns already_delivered with the first payload. The task " +
  "resumes one time.";

const col = (index: number): number => 200 + index * 248;
const colWidth = 232;

/** The delivery diagram: one column for each delivery, with the answer and the effect on the task. */
export const signalsOnce = {
  slug: "signals-once",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);

    ["3 h", "3 h + 5 s", "3 h + 1 min"].forEach((name, index) => {
      d.rows(col(index) + colWidth / 2, 44, [[name, 8, "soft", MONO, 400]]);
    });
    d.divider(col(0), col(2) + colWidth, 52);

    d.text(24, 98, "sendSignal", { size: 10, color: "ink" });
    d.text(24, 174, "Workhorse", { size: 10, color: "ink" });
    d.text(24, 250, "task", { size: 10, color: "ink" });

    for (let index = 0; index < 3; index += 1) {
      const x = col(index) + colWidth / 2;
      d.arrow(`M ${x},116 V 150`);
      d.arrow(`M ${x},192 V 226`);
    }

    d.box(col(0), 76, colWidth, 40, "external", "review-77", "{ approved: true }", 11);
    d.box(col(1), 76, colWidth, 40, "external", "review-77 again", "the same request", 11);
    d.box(col(2), 76, colWidth, 40, "external", "review-78", "{ approved: false }", 11);

    d.box(col(0), 152, colWidth, 40, "store", "delivered", "stores the payload", 11);
    d.box(col(1), 152, colWidth, 40, "store", "duplicate", "returns the stored payload", 11);
    d.box(col(2), 152, colWidth, 40, "store", "already_delivered", "returns the first payload", 11);

    d.box(col(0), 228, colWidth, 40, "focal", "resumes", "one time", 11);
    d.box(col(1), 228, colWidth, 40, "backend", "no change", "does not resume again", 11);
    d.box(col(2), 228, colWidth, 40, "backend", "no change", "does not resume again", 11);

    d.rows(
      24,
      308,
      [
        [
          "The first accepted delivery resumes the task. A later delivery does not change it.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );

    return d.render(this.slug, 960, 324, title, description);
  },
};

const onceEvents: readonly (readonly [time: string, kind: Kind, name: string, sub: string])[] = [
  ["3 h", "focal", "review-77: delivered", "the task resumes"],
  ["3 h + 5 s", "store", "review-77 again: duplicate", "no change"],
  ["3 h + 1 min", "store", "review-78: already_delivered", "no change · first payload"],
];

/** The delivery diagram for screens up to 600 px wide: one delivery on each line. */
export const signalsOnceNarrow = {
  slug: "signals-once-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const pitch = 56;
    onceEvents.forEach(([time, kind, name, sub], index) => {
      const top = 24 + index * pitch;
      if (index > 0) d.arrow(`M 248,${top - 14} V ${top - 2}`);
      d.text(24, top + 25, time, { color: "ink" });
      d.box(112, top, 264, 42, kind, name, sub, 11);
    });
    const footerY = 24 + onceEvents.length * pitch + 8;
    d.rows(
      24,
      footerY,
      [
        ["The first accepted delivery resumes the", 9, "muted", MONO, 400],
        ["task. A later delivery does not change it.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
