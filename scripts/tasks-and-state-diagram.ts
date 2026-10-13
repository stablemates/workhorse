import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The tasks and state diagram: three snapshots of one full-tier task, after each step of the first
 * example of `docs/guides/010-tasks-and-state.md`. It uses the names of that guide.
 *
 * A dashed box is a row that does not exist. The facts:
 *
 * - Enqueue inserts the `task` row and a `ready` `task_runtime` row in one transaction.
 * - A claim changes `task_runtime` to `active` and names the worker. `task` does not change.
 * - Success deletes the `task_runtime` row and inserts a `succeeded` `task_outcome` row in one
 *   transaction. After each committed change, a task has exactly one of the two rows ("Tell a live
 *   task from a finished task").
 * - `task_event` gets `enqueued`, `claimed`, and `succeeded`. `attempt_history` gets one row when
 *   the attempt closes ("Find out what happened to a task").
 *
 * A fast-tier task uses other tables and writes less history. Guide 305 owns that comparison, so
 * this diagram shows the full tier only.
 *
 * Check each fact against its source before you change a label.
 */

type Slot = readonly [kind: "focal" | "backend" | "store", name: string, sub: string] | string;

const taskRow: Slot = ["store", "task", "resize-image · media"];

const snapshots: readonly {
  readonly title: string;
  readonly note: string;
  readonly slots: readonly Slot[];
}[] = [
  {
    title: "1 · After enqueue",
    note: "both rows in one transaction",
    slots: [taskRow, ["backend", "task_runtime", "ready"], "task_outcome"],
  },
  {
    title: "2 · After the claim",
    note: "only task_runtime changes",
    slots: [taskRow, ["backend", "task_runtime", "active · worker A"], "task_outcome"],
  },
  {
    title: "3 · After success",
    note: "delete and insert in one transaction",
    slots: [taskRow, "task_runtime", ["focal", "task_outcome", "succeeded · result"]],
  },
];

const title = "One task after enqueue, after the claim, and after success";
const description =
  "After enqueue, the task has a task row and a ready task_runtime row. After the claim, the " +
  "runtime row is active. After success, the runtime row is gone and a succeeded task_outcome row " +
  "exists. task_event and attempt_history keep the history apart.";

function snapshot(d: Diagram, x: number, y: number, width: number, index: number): void {
  const { title: heading, note, slots } = snapshots[index]!;
  d.rows(
    x,
    y,
    [
      [heading, 12, "ink", SANS, 600],
      [note, 9, "muted", MONO, 400],
    ],
    "start",
  );
  slots.forEach((slot, row) => {
    const top = y + 40 + row * 56;
    if (typeof slot === "string") {
      d.box(x, top, width, 44, "external");
      d.rows(x + width / 2, top + 26, [[`${slot} · no row`, 9, "soft", MONO, 400]]);
      return;
    }
    const [kind, name, sub] = slot;
    d.box(x, top, width, 44, kind, name, sub, 11);
  });
}

export const tasksAndState = {
  slug: "tasks-and-state",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const width = 272;
    const xs = [24, 344, 664] as const;

    d.arrow(`M ${xs[0] + width + 4},160 H ${xs[1] - 6}`);
    d.arrow(`M ${xs[1] + width + 4},160 H ${xs[2] - 6}`);
    xs.forEach((x, index) => snapshot(d, x, 40, width, index));

    d.divider(24, 936, 268);
    d.text(24, 292, "History, kept apart from these rows:", { color: "soft" });
    d.text(24, 310, "task_event", { color: "ink" });
    d.text(120, 310, "enqueued · claimed · succeeded");
    d.text(344, 310, "attempt_history", { color: "ink" });
    d.text(472, 310, "attempt 1 · succeeded");

    return d.render(this.slug, 960, 324, title, description);
  },
};

/** The same diagram for screens up to 600 px wide: the snapshots stand one under the other. */
export const tasksAndStateNarrow = {
  slug: "tasks-and-state-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const pitch = 236;

    for (const index of [0, 1, 2]) {
      const y = 36 + index * pitch;
      if (index > 0) d.arrow(`M 200,${y - 36} V ${y - 18}`);
      snapshot(d, 24, y, 352, index);
    }

    const historyY = 36 + 3 * pitch - 8;
    d.divider(24, 376, historyY);
    d.text(24, historyY + 24, "History, kept apart from these rows:", { color: "soft" });
    d.text(24, historyY + 42, "task_event", { color: "ink" });
    d.text(144, historyY + 42, "enqueued · claimed · succeeded");
    d.text(24, historyY + 60, "attempt_history", { color: "ink" });
    d.text(144, historyY + 60, "attempt 1 · succeeded");

    return d.render(this.slug, 400, historyY + 76, title, description);
  },
};
