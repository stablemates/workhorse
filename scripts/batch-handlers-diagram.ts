import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/315-batch-handlers.md`. They use the names of that guide.
 *
 * "Send several tasks to one handler call": the worker claims 27 `email.send` tasks for a batch
 * handler with `maxSize` 20 and `lingerMs` 50. The first 20 make a full batch, and the handler gets
 * them at once. The other seven make a partial batch; the linger starts when the first of them
 * arrives, and the handler gets them when it ends. Each call sends one provider request.
 *
 * "Return one outcome for each task": the handler returns one outcome for each item, in item
 * order. Workhorse applies each outcome to its own task with its own fence token. A failed task
 * follows its own retry policy. If the handler throws, every task of the batch fails, each with its
 * own retry budget.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

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

const timingTitle = "A full batch runs at once, and a partial batch runs after the linger";
const timingDescription =
  "A worker with a batch handler for email.send claims 27 tasks. The handler takes a maximum of " +
  "20 tasks, with a linger of 50 ms. The first 20 tasks make a full batch, and the handler gets " +
  "them at once. The other seven wait for the linger, and the handler gets them at about 50 ms. " +
  "27 tasks need two provider requests.";

const AXIS_LEFT = 260;
const MS = 10;
const at = (ms: number): number => AXIS_LEFT + ms * MS;
const CALL = 150;

/** The timing diagram: one row for each batch, on one axis from 0 ms to 60 ms. */
export const batchTiming = {
  slug: "batch-handlers-timing",
  title: timingTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(
      24,
      40,
      [
        ["email.send", 12, "ink", SANS, 600],
        ["maxSize 20 · lingerMs 50", 9, "muted", MONO, 400],
      ],
      "start",
    );
    for (let ms = 0; ms <= 60; ms += 10) {
      d.rows(at(ms), 44, [[`${ms} ms`, 8, "soft", MONO, 400]]);
    }
    d.divider(at(0), at(60), 52);

    const rowLabel = (y: number, name: string, sub: string): void => {
      d.rows(
        24,
        y + 16,
        [
          [name, 11, "ink", SANS, 600],
          [sub, 9, "muted", MONO, 400],
        ],
        "start",
      );
    };

    rowLabel(72, "batch 1", "20 tasks · full");
    d.box(at(0), 72, CALL, 40, "focal", "handler call", "provider request 1", 11);

    rowLabel(128, "batch 2", "7 tasks · partial");
    d.arrow(`M ${at(50) - 8},148 H ${at(50) - 2}`);
    d.box(
      at(0),
      128,
      at(50) - at(0) - 12,
      40,
      "external",
      "linger 50 ms",
      "waits for more tasks",
      11,
    );
    d.box(at(50), 128, CALL, 40, "backend", "handler call", "provider request 2", 11);

    d.rows(
      24,
      208,
      [
        [
          "27 tasks need two provider requests, not 27. Each task keeps its own lease and fence token.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 224, timingTitle, timingDescription);
  },
};

/** The timing diagram for screens up to 600 px wide: one event on each line. */
export const batchTimingNarrow = {
  slug: "batch-handlers-timing-narrow",
  title: timingTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["0 ms", "store", "27 tasks claimed", "each fills one slot"],
        ["0 ms", "focal", "batch 1: 20 tasks", "full · provider request 1"],
        ["0–50 ms", "external", "batch 2: 7 tasks", "the linger waits for more"],
        ["50 ms", "backend", "batch 2 runs", "provider request 2"],
      ],
      ["27 tasks need two provider requests,", "not 27."],
    );
    return d.render(this.slug, 400, height, timingTitle, timingDescription);
  },
};

const outcomesTitle = "Each outcome of a batch applies to its own task";
const outcomesDescription =
  "The handler of the first batch returns 20 outcomes, in the order of the items. Nineteen are " +
  "succeeded, and Workhorse completes each of these tasks with its own fence token. One is failed, " +
  "and that task follows its own retry policy and attempt budget. If the handler throws an error, " +
  "all 20 tasks fail, each with its own retry budget.";

/** The outcome diagram: one handler result, split into the outcome of each task. */
export const batchOutcomes = {
  slug: "batch-handlers-outcomes",
  title: outcomesTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.arrow("M 324,112 H 420 V 84 H 494");
    d.arrow("M 324,112 H 420 V 160 H 494");

    d.box(24, 80, 300, 64, "store", "handler returns 20 outcomes", "in the order of the items", 11);
    d.box(
      496,
      56,
      440,
      56,
      "backend",
      "19 succeeded",
      "each task completes with its own fence token",
      11,
    );
    d.box(496, 132, 440, 56, "focal", "1 failed", "its own retry policy and attempt budget", 11);

    d.box(
      24,
      216,
      912,
      44,
      "external",
      "if the handler throws an error",
      "all 20 tasks fail · each with its own retry budget",
      11,
    );

    d.rows(
      24,
      292,
      [
        [
          "A batch shares one handler call. Leases, fence tokens, retries, and cancellation stay with each task.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 308, outcomesTitle, outcomesDescription);
  },
};

/** The outcome diagram for screens up to 600 px wide: one result on each line. */
export const batchOutcomesNarrow = {
  slug: "batch-handlers-outcomes-narrow",
  title: outcomesTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["returns", "store", "20 outcomes", "in the order of the items"],
        ["19", "backend", "succeeded", "each with its own fence token"],
        ["1", "focal", "failed", "its own retry policy"],
      ],
      ["If the handler throws, all 20 tasks fail,", "each with its own retry budget."],
    );
    return d.render(this.slug, 400, height, outcomesTitle, outcomesDescription);
  },
};
