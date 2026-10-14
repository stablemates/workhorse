import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/145-human-decisions.md`. They use the names of that guide.
 *
 * "Wait for a human decision": worker A runs the handler for `acct-19`, and
 * `ctx.waitForHuman("account-review", …)` stores the context and releases the lease. At 40 min,
 * an operator approves, and Workhorse stores the result and sets the task to `ready`. Worker B
 * runs the handler from the first line, and the wait returns the stored result at once. The wait
 * uses no attempt; the second claim gets a new fence token. The fence numbers are an illustration.
 * The layout is the layout of `signals-wait`, so a reader can compare the two waits.
 *
 * "Close a decision that nobody answers" and the sections before it: `complete_human_wait_v1`
 * returns `completed` for the dashboard quick action and for `Queue.completeHumanWait`, and the
 * task becomes ready. At the wait boundary, maintenance fails the task with a deadline error.
 * Cancellation ends a parked task at once. A completion after either returns `stale`.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const waitTitle = "A human wait frees the worker until a person decides";
const waitDescription =
  "At 0 s, worker A runs the handler for acct-19, and the handler waits for the account-review " +
  "decision. No worker holds the task during the wait, and the dashboard shows the decision to " +
  "operators. At 40 min, an operator approves, and Workhorse stores the result and sets the task " +
  "to ready. Worker B runs the handler from its first line. The wait returns the stored result, " +
  "and the handler activates the account. Both runs are attempt 1.";

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
export const humanWait = {
  slug: "human-decisions-wait",
  title: waitTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    ['ctx.waitForHuman("account-review", …)', "activateAccount()"].forEach((line, index) => {
      d.rows(waitColumns[index]! + WAIT_WIDTH / 2, 52, [[line, 10, "ink", MONO, 400]]);
    });
    d.divider(192, 936, 68);

    waitRun(
      d,
      84,
      ["Run 1", "worker A · 0 s", "attempt 1 · fence 1"],
      [["focal", "waits", "stores the context · frees the slot"], undefined],
    );

    d.box(192, 148, 744, 40, "external");
    d.rows(564, 172, [
      [
        "no worker holds the task · the dashboard shows the decision to operators",
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
        ["0 s to 40 min", 9, "soft", MONO, 400],
      ],
      "start",
    );

    d.box(
      192,
      204,
      744,
      44,
      "store",
      "an operator approves: { approved: true }",
      "Workhorse stores the result · the task becomes ready",
      11,
    );
    d.rows(
      24,
      222,
      [
        ["the decision", 9, "muted", MONO, 400],
        ["40 min", 9, "soft", MONO, 400],
      ],
      "start",
    );

    waitRun(
      d,
      264,
      ["Run 2", "worker B · after 40 min", "attempt 1 · fence 2"],
      [
        ["store", "returns", "the stored result at once"],
        ["backend", "runs", "activates acct-19 · task succeeds"],
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
  ["0 s", "focal", "worker A: waitForHuman", "stores the context · frees the slot"],
  ["0 s to 40 min", "external", "no worker holds the task", "the dashboard shows the decision"],
  ["40 min", "store", "an operator approves", "result stored · task ready"],
  ["after 40 min", "store", "worker B: the wait returns", "the stored result at once"],
  ["", "backend", "activateAccount runs", "activates acct-19 · task succeeds"],
];

/** The wait diagram for screens up to 600 px wide: one event on each line. */
export const humanWaitNarrow = {
  slug: "human-decisions-wait-narrow",
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

const endsTitle = "A result resumes a pending decision, and a time limit or a cancellation ends it";
const endsDescription =
  "The task for acct-19 waits on account-review. If an operator selects the Approve quick action, " +
  "or the custom tool calls completeHumanWait with rev-4, Workhorse stores the result and the task " +
  "becomes ready. If nobody answers before timeoutMs passes, maintenance fails the task with a " +
  "deadline error. If the app cancels the task, Workhorse cancels it at once. After a failure or a " +
  "cancellation, a late answer returns stale.";

const col = (index: number): number => 200 + index * 188;
const colWidth = 172;

type EndColumn = readonly [
  heading: string,
  request: readonly [string, string],
  workhorse: readonly [string, string],
  task: readonly [Kind, string, string],
];

const endColumns: readonly EndColumn[] = [
  [
    "dashboard quick action",
    ["Approve", "the operator confirms"],
    ["completed", "stores the result"],
    ["focal", "ready", "the handler runs again"],
  ],
  [
    "completeHumanWait",
    ["rev-4", "{ approved: true }"],
    ["completed", "stores the result"],
    ["focal", "ready", "the handler runs again"],
  ],
  [
    "timeoutMs passes",
    ["no answer", "until 1 day"],
    ["maintenance", "deadline error"],
    ["backend", "failed", "a late answer: stale"],
  ],
  [
    "cancellation",
    ["cancel the task", "while it waits"],
    ["canceled", "at once"],
    ["backend", "canceled", "a late answer: stale"],
  ],
];

/** The end diagram: one column for each way a pending decision ends. */
export const humanEnds = {
  slug: "human-decisions-ends",
  title: endsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    endColumns.forEach(([heading], index) => {
      d.rows(col(index) + colWidth / 2, 44, [[heading, 8, "soft", MONO, 400]]);
    });
    d.divider(col(0), col(3) + colWidth, 52);

    d.text(24, 98, "decision", { size: 10, color: "ink" });
    d.text(24, 174, "Workhorse", { size: 10, color: "ink" });
    d.text(24, 250, "task", { size: 10, color: "ink" });

    endColumns.forEach(([, request, workhorse, task], index) => {
      const x = col(index) + colWidth / 2;
      d.arrow(`M ${x},116 V 150`);
      d.arrow(`M ${x},192 V 226`);
      d.box(col(index), 76, colWidth, 40, "external", request[0], request[1], 11);
      d.box(col(index), 152, colWidth, 40, "store", workhorse[0], workhorse[1], 11);
      d.box(col(index), 228, colWidth, 40, task[0], task[1], task[2], 11);
    });

    d.rows(
      24,
      308,
      [
        [
          "A result resumes the task. A time limit or a cancellation ends it, and a late answer returns stale.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 324, endsTitle, endsDescription);
  },
};

const endEvents: readonly (readonly [heading: string, kind: Kind, name: string, sub: string])[] = [
  ["quick action", "focal", "Approve: completed", "the task is ready"],
  ["completeHumanWait", "focal", "rev-4: completed", "the task is ready"],
  ["timeoutMs passes", "backend", "maintenance: failed", "a late answer: stale"],
  ["cancellation", "backend", "cancel: canceled", "a late answer: stale"],
];

/** The end diagram for screens up to 600 px wide: one way on each line. */
export const humanEndsNarrow = {
  slug: "human-decisions-ends-narrow",
  title: endsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const pitch = 56;
    endEvents.forEach(([heading, kind, name, sub], index) => {
      const top = 24 + index * pitch;
      d.rows(24, top + 25, [[heading, 8, "ink", MONO, 400]], "start");
      d.box(176, top, 200, 42, kind, name, sub, 11);
    });
    const footerY = 24 + endEvents.length * pitch + 8;
    d.rows(
      24,
      footerY,
      [
        ["A result resumes the task. A time limit or", 9, "muted", MONO, 400],
        ["a cancellation ends it, and a late answer", 9, "muted", MONO, 400],
        ["returns stale.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 48, endsTitle, endsDescription);
  },
};
