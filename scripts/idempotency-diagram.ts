import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/210-enqueue-idempotency.md`. They use the names of that guide.
 *
 * "Prevent a duplicate task" and "Do not use one key for different data": the first request for
 * `capture:7781` in the scope `invoice-capture` binds the key and creates the task
 * (`enqueueWithResult` outcome `accepted`). The same request returns the same `taskId` (outcome
 * `replayed`). A request with the same key and a different payload raises a conflict error; the
 * original task does not change, and no second task exists.
 *
 * "Set how long a key stays active": `ttlMs` defaults to one day. A completed task does not end
 * the key, and a repeat does not make the time limit longer. After the limit, the same request
 * creates a new task.
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
  columns: readonly string[],
  rows: readonly (readonly [name: string, cells: readonly Cell[]])[],
): { readonly x: (index: number) => number; readonly width: number; readonly bottom: number } {
  const pitch = (RIGHT - LEFT + GAP) / columns.length;
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
  return { x, width, bottom: 72 + rows.length * 56 };
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

function eventList(
  d: Diagram,
  events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[],
  lines: readonly string[],
): number {
  const pitch = 56;
  events.forEach(([label, kind, name, sub], index) => {
    const top = 24 + index * pitch;
    d.text(24, top + 25, label, { color: "ink" });
    d.box(112, top, 264, 42, kind, name, sub, 11);
  });
  return footer(d, 24 + events.length * pitch + 8, lines) + 16;
}

const outcomesTitle = "One key gives one task. A changed request with the same key fails";
const outcomesDescription =
  "The first request for capture:7781 binds the key and creates the invoice.capture task. The " +
  "same request again finds the key and returns the same taskId. A request with the same key and " +
  "a different payload raises a conflict error. The original task does not change, and Workhorse " +
  "creates no second task.";

/** The outcome diagram: one column for each request with the key `capture:7781`. */
export const idempotencyOutcomes = {
  slug: "idempotency-outcomes",
  title: outcomesTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const { bottom } = grid(
      d,
      ["capture:7781", "scope invoice-capture"],
      ["the first request", "the same request again", "a different payload"],
      [
        [
          "request",
          [
            ["external", "invoice.capture", "{ invoiceId: 7781 }"],
            ["external", "invoice.capture", "the same data"],
            ["external", "invoice.capture", "the payload is different"],
          ],
        ],
        [
          "Workhorse",
          [
            ["store", "binds the key", "creates the task"],
            ["store", "finds the key", "the request is the same"],
            ["store", "finds the key", "compares the request"],
          ],
        ],
        [
          "result",
          [
            ["backend", "accepted", "a new taskId"],
            ["focal", "replayed", "the same taskId"],
            ["backend", "conflict error", "no change · no second task"],
          ],
        ],
      ],
    );
    const height = footer(d, bottom + 24, [
      "Workhorse records the first request. Each later request with the same key must be the same.",
    ]);
    return d.render(this.slug, 960, height, outcomesTitle, outcomesDescription);
  },
};

/** The outcome diagram for screens up to 600 px wide: one request on each line. */
export const idempotencyOutcomesNarrow = {
  slug: "idempotency-outcomes-narrow",
  title: outcomesTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["first", "backend", "accepted", "binds the key · a new taskId"],
        ["again", "focal", "replayed", "the same taskId"],
        ["changed", "backend", "conflict error", "no change · no second task"],
      ],
      ["Each later request with the same key", "must be the same as the first request."],
    );
    return d.render(this.slug, 400, height, outcomesTitle, outcomesDescription);
  },
};

const lifetimeTitle = "A key stays active for its time limit, also after the task completes";
const lifetimeDescription =
  "The key capture:7781 has the default time limit of one day. At 0 h, the first request creates " +
  "the task. At 1 min, a worker completes it. At 3 h, a client repeats the request and gets the " +
  "original task. At 25 h, the key is no longer active, and the same request creates a new task.";

/** The lifetime diagram: the key is one band under the four moments of the `ttlMs` example. */
export const idempotencyLifetime = {
  slug: "idempotency-lifetime",
  title: lifetimeTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const { x, width, bottom } = grid(
      d,
      ["capture:7781", "ttlMs: 1 day"],
      ["0 h", "1 min", "3 h", "25 h"],
      [
        [
          "request",
          [
            ["external", "the first request", "from the client"],
            undefined,
            ["external", "the same request", "the client repeats it"],
            ["external", "the same request", "the client repeats it"],
          ],
        ],
        [
          "task",
          [
            ["store", "created", "accepted"],
            ["backend", "succeeded", "a worker completes it"],
            ["focal", "the original task", "replayed"],
            ["store", "a new task", "accepted"],
          ],
        ],
      ],
    );
    const keyY = bottom;
    d.text(24, keyY + 25, "key", { size: 10, color: "ink" });
    d.box(
      x(0),
      keyY,
      x(2) + width - x(0),
      40,
      "store",
      "active",
      "a repeat does not make the time limit longer",
      11,
    );
    d.box(x(3), keyY, width, 40, "external", "no longer active", "after 1 day", 11);
    const height = footer(d, keyY + 64, [
      "Set ttlMs to the longest time in which a client can repeat a request.",
    ]);
    return d.render(this.slug, 960, height, lifetimeTitle, lifetimeDescription);
  },
};

/** The lifetime diagram for screens up to 600 px wide: one moment on each line. */
export const idempotencyLifetimeNarrow = {
  slug: "idempotency-lifetime-narrow",
  title: lifetimeTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["0 h", "store", "accepted", "the key is active for 1 day"],
        ["1 min", "backend", "the task succeeds", "the key stays active"],
        ["3 h", "focal", "replayed", "the original task"],
        ["25 h", "store", "accepted", "the key is no longer active"],
      ],
      ["Set ttlMs to the longest time in which", "a client can repeat a request."],
    );
    return d.render(this.slug, 400, height, lifetimeTitle, lifetimeDescription);
  },
};
