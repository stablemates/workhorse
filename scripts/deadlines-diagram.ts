import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/140-deadlines-and-timeouts.md`. They use the names of that guide.
 * Both use the same rows (attempts, task), so the reader can compare what each limit ends.
 *
 * "Stop a task at a fixed time": a `price.quote` task has a deadline of 20:00. Attempts 1 to 3 fail
 * until 19:40, and attempt 4 waits until 20:05. At 20:00 the task is `scheduled` and no worker holds
 * it. Soon after, `recover_expired_v1` from worker maintenance settles the deadline: the task fails,
 * and attempt 4 does not start.
 *
 * "Stop one attempt that runs too long": a `report.build` task has an execution timeout of 2 min.
 * At 2 min, `expire_owned_v1` closes attempt 1 as timed out and schedules attempt 2 under the retry
 * rules. Then the worker aborts `ctx.signal`. Attempt 2 starts with a full budget, because a retry
 * resets `execution_used_ms`.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";
type Cell = readonly [kind: Kind, name: string, sub: string] | undefined;

const col = (index: number): number => 200 + index * 188;
const colWidth = 172;

function grid(
  d: Diagram,
  top: number,
  heading: readonly [string, string],
  times: readonly string[],
  attempts: readonly Cell[],
  task: readonly Cell[],
): void {
  d.rows(
    24,
    top,
    [
      [heading[0], 12, "ink", SANS, 600],
      [heading[1], 9, "muted", MONO, 400],
    ],
    "start",
  );
  times.forEach((time, index) => {
    d.rows(col(index) + colWidth / 2, top + 4, [[time, 8, "soft", MONO, 400]]);
  });
  d.divider(col(0), col(3) + colWidth, top + 12);
  const row = (y: number, name: string, cells: readonly Cell[]): void => {
    d.text(24, y + 25, name, { size: 10, color: "ink" });
    cells.forEach((cell, index) => {
      if (cell) d.box(col(index), y, colWidth, 40, cell[0], cell[1], cell[2], 11);
    });
  };
  row(top + 32, "attempts", attempts);
  row(top + 88, "task", task);
}

const deadlineTitle = "A deadline ends the task, even if attempts are left";
const deadlineDescription =
  "A price.quote task has a deadline of 20:00. Attempts 1 to 3 fail between 18:00 and 19:40, and " +
  "attempt 4 waits until 20:05. At 20:00, the deadline passes while no worker holds the task. Soon " +
  "after, maintenance ends the task as failed, and attempt 4 does not start.";

function deadlineGrid(d: Diagram, top: number): void {
  grid(
    d,
    top,
    ["price.quote", "deadline 20:00"],
    ["18:00", "until 19:40", "20:00", "20:05"],
    [
      ["backend", "attempt 1 fails", "the provider is down"],
      ["backend", "attempts 2 and 3 fail", "each wait is longer"],
      undefined,
      ["external", "attempt 4", "does not start"],
    ],
    [
      ["store", "scheduled", "waits for attempt 2"],
      ["store", "scheduled", "attempt 4 at 20:05"],
      ["focal", "failed", "soon after 20:00"],
      undefined,
    ],
  );
}

/** The deadline diagram: one column for each event, with the attempts and the task. */
export const deadlineEnds = {
  slug: "deadlines-deadline",
  title: deadlineTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    deadlineGrid(d, 40);
    d.rows(
      24,
      212,
      [
        [
          "A deadline ends the task at a fixed time. Attempts that are left do not start.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 228, deadlineTitle, deadlineDescription);
  },
};

const timeoutTitle = "An execution timeout ends one attempt, and the task continues";
const timeoutDescription =
  "A report.build task has an execution timeout of 2 min. At 0 s, a worker claims it, and the call " +
  "to the reporting service does not return. At 2 min, PostgreSQL closes attempt 1 as timed out and " +
  "schedules attempt 2. The worker aborts the signal of the handler. Attempt 2 starts with a full " +
  "budget of 2 min.";

function timeoutGrid(d: Diagram, top: number): void {
  grid(
    d,
    top,
    ["report.build", "execution timeout 2 min"],
    ["0 s", "2 min", "then", "after the retry delay"],
    [
      ["backend", "attempt 1 runs", "the call does not return"],
      ["focal", "attempt 1 timed out", "PostgreSQL closes it"],
      ["backend", "ctx.signal aborted", "the handler must stop"],
      ["backend", "attempt 2 starts", "full budget of 2 min"],
    ],
    [
      ["store", "active", "worker A"],
      ["store", "scheduled", "the retry rules apply"],
      undefined,
      ["store", "active", "a new attempt"],
    ],
  );
}

/** The execution timeout diagram, with the same rows as the deadline diagram. */
export const timeoutEnds = {
  slug: "deadlines-timeout",
  title: timeoutTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    timeoutGrid(d, 40);
    d.rows(
      24,
      212,
      [
        [
          "A timeout ends one attempt. If attempts are left, the task gets another attempt.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 228, timeoutTitle, timeoutDescription);
  },
};

const deadlineEvents: readonly (readonly [time: string, kind: Kind, name: string, sub: string])[] =
  [
    ["18:00", "backend", "attempt 1 fails", "the provider is down"],
    ["until 19:40", "backend", "attempts 2 and 3 fail", "attempt 4 waits until 20:05"],
    ["20:00", "store", "the deadline passes", "scheduled · no worker holds it"],
    ["soon after", "focal", "the task fails", "maintenance ends it"],
    ["20:05", "external", "attempt 4", "does not start"],
  ];

const timeoutEvents: readonly (readonly [time: string, kind: Kind, name: string, sub: string])[] = [
  ["0 s", "backend", "attempt 1 runs", "the call does not return"],
  ["2 min", "focal", "attempt 1 timed out", "PostgreSQL schedules attempt 2"],
  ["then", "backend", "ctx.signal aborted", "the handler must stop"],
  ["later", "backend", "attempt 2 starts", "full budget of 2 min"],
];

function eventList(
  d: Diagram,
  events: readonly (readonly [time: string, kind: Kind, name: string, sub: string])[],
  footer: readonly string[],
): number {
  const pitch = 56;
  events.forEach(([time, kind, name, sub], index) => {
    const top = 24 + index * pitch;
    if (index > 0) d.arrow(`M 248,${top - 14} V ${top - 2}`);
    d.text(24, top + 25, time, { color: "ink" });
    d.box(112, top, 264, 42, kind, name, sub, 11);
  });
  const footerY = 24 + events.length * pitch + 8;
  d.rows(
    24,
    footerY,
    footer.map((line) => [line, 9, "muted", MONO, 400] as const),
    "start",
  );
  return footerY + 17 + footer.length * 15;
}

/** The deadline diagram for screens up to 600 px wide: one event on each line. */
export const deadlineEndsNarrow = {
  slug: "deadlines-deadline-narrow",
  title: deadlineTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(d, deadlineEvents, [
      "A deadline ends the task at a fixed time.",
      "Attempts that are left do not start.",
    ]);
    return d.render(this.slug, 400, height, deadlineTitle, deadlineDescription);
  },
};

/** The execution timeout diagram for screens up to 600 px wide: one event on each line. */
export const timeoutEndsNarrow = {
  slug: "deadlines-timeout-narrow",
  title: timeoutTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(d, timeoutEvents, [
      "A timeout ends one attempt. If attempts are",
      "left, the task gets another attempt.",
    ]);
    return d.render(this.slug, 400, height, timeoutTitle, timeoutDescription);
  },
};
