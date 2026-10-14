import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `docs/guides/305-fast-tier.md`: the writes of one task on each tier, after each
 * step of the first example. It uses the layout of the snapshot diagram of guide 010 and the table
 * names of `docs/architecture/fast-tier.md`.
 *
 * - Full tier: enqueue writes `task`, a `ready` `task_runtime` row, and an `enqueued` event. The
 *   claim changes `task_runtime` and adds a `claimed` event. Success deletes the runtime row and
 *   writes a `task_outcome` row, an event, and an `attempt_history` row.
 * - Fast tier: enqueue writes `task` and a `ready` `fast_task_runtime` row, and no event. The claim
 *   changes only `fast_task_runtime`. Success deletes it and writes one `fast_task_outcome` row.
 *   `attempt_history` rows and `claimed` events are written only when the queue enables them.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";
type Write = readonly [kind: Kind, name: string, sub: string];

const columns = ["1 · After enqueue", "2 · After the claim", "3 · After success"] as const;

const tiers: readonly (readonly [
  tier: string,
  note: string,
  cells: readonly (readonly Write[])[],
])[] = [
  [
    "full tier",
    "the default",
    [
      [
        ["store", "task", "the identity"],
        ["store", "task_runtime", "ready"],
        ["backend", "task_event", "enqueued"],
      ],
      [
        ["store", "task_runtime", "active · worker A"],
        ["backend", "task_event", "claimed"],
      ],
      [
        ["store", "task_outcome", "succeeded"],
        ["backend", "task_event", "succeeded"],
        ["backend", "attempt_history", "attempt 1"],
      ],
    ],
  ],
  [
    "fast tier",
    "set by an operator",
    [
      [
        ["store", "task", "the identity"],
        ["store", "fast_task_runtime", "ready · no event"],
      ],
      [["store", "fast_task_runtime", "active · worker A"]],
      [["focal", "fast_task_outcome", "succeeded · no event, no history"]],
    ],
  ],
];

const title = "The writes of one task on the full tier and on the fast tier";
const description =
  "On the full tier, enqueue writes the task row, a ready task_runtime row, and an enqueued event. " +
  "The claim changes task_runtime and adds a claimed event. Success writes a task_outcome row, an " +
  "event, and an attempt_history row. On the fast tier, enqueue writes the task row and a ready " +
  "fast_task_runtime row. The claim changes only that row. Success writes one fast_task_outcome " +
  "row. History is written only when the queue enables it.";

const CELL = 240;
const cellX = (index: number): number => 200 + index * (CELL + 8);
const ROW = 44;

/** The comparison: one row for each tier, one column for each moment. */
export const tierWrites = {
  slug: "fast-tier-writes",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    columns.forEach((column, index) => {
      d.rows(cellX(index), 40, [[column, 11, "ink", SANS, 600]], "start");
    });
    d.divider(200, 936, 52);

    let y = 68;
    tiers.forEach(([tier, note, cells]) => {
      const height = Math.max(...cells.map((cell) => cell.length)) * (ROW + 6);
      d.rows(
        24,
        y + 16,
        [
          [tier, 12, "ink", SANS, 600],
          [note, 9, "muted", MONO, 400],
        ],
        "start",
      );
      cells.forEach((cell, index) => {
        cell.forEach(([kind, name, sub], row) => {
          d.box(cellX(index), y + row * (ROW + 6), CELL, ROW, kind, name, sub, 11);
        });
      });
      y += height + 18;
    });

    d.rows(
      24,
      y + 8,
      [
        [
          "On the fast tier, attempt_history rows and claimed events are opt-in for each queue.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, y + 24, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["full", "store", "enqueue", "task · task_runtime · event"],
  ["full", "store", "claim", "task_runtime · event"],
  ["full", "store", "success", "task_outcome · event · history"],
  ["fast", "store", "enqueue", "task · fast_task_runtime"],
  ["fast", "store", "claim", "fast_task_runtime"],
  ["fast", "focal", "success", "fast_task_outcome · no history"],
];

/** The comparison for screens up to 600 px wide: one moment of one tier on each line. */
export const tierWritesNarrow = {
  slug: "fast-tier-writes-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const pitch = 56;
    events.forEach(([label, kind, name, sub], index) => {
      const top = 24 + index * pitch + (index >= 3 ? 16 : 0);
      d.text(24, top + 25, label, { color: "ink" });
      d.box(112, top, 264, 42, kind, name, sub, 11);
    });
    const footerY = 24 + events.length * pitch + 24;
    d.rows(
      24,
      footerY,
      [
        ["On the fast tier, history rows and claimed", 9, "muted", MONO, 400],
        ["events are opt-in for each queue.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
