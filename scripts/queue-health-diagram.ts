import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/360-queue-health.md`. They use the names of that guide.
 *
 * "Read the whole queue at one instant": two separate queries can see `invoice-7` twice, as an
 * expired lease and as a ready task after recovery. `Queue.health()` reads every exact value in one
 * SQL statement, so PostgreSQL gives it one consistent view at the instant `capturedAt`.
 *
 * "Act on the verdict and its reasons": when the workers of `billing` stop, the oldest due task
 * waits longer than its budget, and the verdict becomes `critical` with `stalled-promotion`. When
 * the running leases expire with no recovery, it adds `expired-leases`. Each reason has a stable
 * code, the observed value, and the budget.
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
): number {
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
  return 72 + rows.length * 56;
}

function footer(d: Diagram, y: number, line: string): number {
  d.rows(24, y, [[line, 9, "muted", MONO, 400]], "start");
  return y + 16;
}

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

const snapshotTitle = "Two queries can report a problem that does not exist; one statement cannot";
const snapshotDescription =
  "A report reads billing with two separate queries. At 0 ms, the first query finds the expired " +
  "lease of invoice-7. At 3 ms, recovery makes invoice-7 ready again. At 5 ms, the second query " +
  "counts invoice-7 as ready. The report shows a problem and its recovery together. Queue.health() " +
  "reads all exact values in one SQL statement, so every value is from the instant capturedAt.";

/** The snapshot diagram: two separate queries, then the single statement of `Queue.health()`. */
export const healthSnapshot = {
  slug: "queue-health-snapshot",
  title: snapshotTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const bottom = grid(
      d,
      ["billing", "invoice-7 · worker A stopped"],
      ["0 ms", "3 ms", "5 ms"],
      [
        [
          "two queries",
          [
            ["external", "query 1: expired leases", "finds invoice-7"],
            ["backend", "recovery", "invoice-7 is ready again"],
            ["focal", "query 2: tasks by state", "counts invoice-7 as ready"],
          ],
        ],
      ],
    );
    d.text(24, bottom + 25, "Queue.health()", { size: 10, color: "ink" });
    d.box(
      LEFT,
      bottom,
      RIGHT - LEFT,
      40,
      "store",
      "one SQL statement",
      "one consistent view · capturedAt",
      11,
    );
    return d.render(
      this.slug,
      960,
      footer(
        d,
        bottom + 72,
        "Every count, depth, and watermark of the snapshot is from the same instant.",
      ),
      snapshotTitle,
      snapshotDescription,
    );
  },
};

/** The snapshot diagram for screens up to 600 px wide: one event on each line. */
export const healthSnapshotNarrow = {
  slug: "queue-health-snapshot-narrow",
  title: snapshotTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["0 ms", "external", "query 1: expired leases", "finds invoice-7"],
        ["3 ms", "backend", "recovery", "invoice-7 is ready again"],
        ["5 ms", "focal", "query 2: tasks by state", "counts invoice-7 as ready"],
      ],
      ["Queue.health() reads all exact values in", "one statement, at the instant capturedAt."],
    );
    return d.render(this.slug, 400, height, snapshotTitle, snapshotDescription);
  },
};

const verdictTitle = "The verdict collects one reason for each budget that the queue exceeds";
const verdictDescription =
  "A bad deployment stops all workers of billing. Scheduled tasks become due, and no worker tick " +
  "moves them to ready. When the oldest due task waits longer than its budget, the verdict becomes " +
  "critical with the reason stalled-promotion. When the leases of the running tasks expire with no " +
  "recovery, the verdict adds expired-leases. Each reason has a code, the observed value, and the " +
  "budget.";

/** The verdict diagram: the verdict and its reasons after each event. */
export const healthVerdict = {
  slug: "queue-health-verdict",
  title: verdictTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const bottom = grid(
      d,
      ["billing", "the workers stop"],
      ["before", "due tasks wait", "leases expire"],
      [
        [
          "event",
          [
            ["backend", "workers run", "each tick moves due tasks"],
            ["external", "no worker tick", "the oldest due task waits"],
            ["external", "no recovery", "running leases expire"],
          ],
        ],
        [
          "verdict",
          [
            ["store", "healthy", "no budget exceeded"],
            ["focal", "critical", "stalled-promotion"],
            ["focal", "critical", "stalled-promotion · expired-leases"],
          ],
        ],
      ],
    );
    return d.render(
      this.slug,
      960,
      footer(
        d,
        bottom + 32,
        "Each reason has a stable code, the observed value, and the budget that the value exceeds.",
      ),
      verdictTitle,
      verdictDescription,
    );
  },
};

/** The verdict diagram for screens up to 600 px wide: one event on each line. */
export const healthVerdictNarrow = {
  slug: "queue-health-verdict-narrow",
  title: verdictTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["before", "store", "healthy", "the workers run"],
        ["stop", "focal", "critical", "stalled-promotion"],
        ["later", "focal", "critical", "+ expired-leases"],
      ],
      ["Each reason has a code, the observed", "value, and the budget."],
    );
    return d.render(this.slug, 400, height, verdictTitle, verdictDescription);
  },
};
