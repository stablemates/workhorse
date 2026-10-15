import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagram of "Read the state of a task" in `site/content/docs/concepts.mdx`. It replaces the
 * text diagram of that section and uses its names.
 *
 * A task is always in one of seven states. The four live states are in `task_runtime`, and the
 * three finished states are in `task_outcome`. A blocked task waits for prerequisite tasks; when
 * they finish, its dependency policy makes it ready or finishes it. A scheduled task has a future
 * `runAt`, a retry delay, or a durable sleep. A ready task waits for a worker. An active task has
 * one owner under a lease. A failed attempt with attempts left retries through `scheduled`, or
 * directly through `ready` when the delay is zero.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const title = "A task is in one of seven states: four live and three finished";
const description =
  "A live task is blocked, scheduled, ready, or active, and it has a task_runtime row. A blocked " +
  "task waits for its prerequisite tasks. A scheduled task waits for its run time, a retry delay, " +
  "or a durable sleep. A ready task waits for a worker, and a worker claim makes it active. An " +
  "active task finishes as succeeded, failed, or canceled, in task_outcome. If a failed attempt has " +
  "attempts left, the task retries through scheduled, or through ready when the delay is zero.";

const live: readonly (readonly [name: string, sub: string, kind: Kind])[] = [
  ["blocked", "waits for prerequisites", "backend"],
  ["scheduled", "waits for its run time", "backend"],
  ["ready", "waits for a worker", "backend"],
  ["active", "one worker, a lease", "focal"],
];

const finished: readonly (readonly [name: string, sub: string, kind: Kind])[] = [
  ["succeeded", "the result", "store"],
  ["failed", "the error", "external"],
  ["canceled", "the envelope", "external"],
];

const BOX = 148;
const GAP = 24;
const x = (index: number): number => 40 + index * (BOX + GAP);
const ROW = 140;

/** The state diagram: the live states in one row, the finished states in one column. */
export const taskLifecycle = {
  slug: "task-lifecycle",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.zone(24, 64, x(3) + BOX - 24 + 16, 192, "LIVE · task_runtime");
    d.zone(744, 64, 192, 192, "FINISHED · task_outcome");

    for (let index = 0; index < 3; index += 1) {
      d.arrow(`M ${x(index) + BOX},${ROW + 24} H ${x(index + 1) - 2}`);
    }
    // Retry from active back to scheduled (a delay) and to ready (zero delay), above the row.
    d.arrow(`M ${x(3) + 44},${ROW} V ${ROW - 40} H ${x(1) + BOX / 2} V ${ROW - 2}`, {
      dashed: true,
    });
    d.label((x(1) + BOX / 2 + x(3) + 44) / 2, ROW - 46, "retry with a delay");
    d.arrow(`M ${x(3) + 24},${ROW} V ${ROW - 20} H ${x(2) + BOX / 2} V ${ROW - 2}`, {
      dashed: true,
    });
    d.label((x(2) + BOX / 2 + x(3) + 24) / 2, ROW - 26, "zero delay");
    // Prerequisites finish: blocked goes straight to ready, below the row.
    d.arrow(`M ${x(0) + BOX / 2},${ROW + 48} V ${ROW + 84} H ${x(2) + BOX / 2} V ${ROW + 50}`);
    d.label((x(0) + x(2) + BOX) / 2, ROW + 78, "prerequisites finish");

    live.forEach(([name, sub, kind], index) => {
      d.box(x(index), ROW, BOX, 48, kind, name, sub, 11);
    });

    const outX = 760;
    finished.forEach(([name, sub, kind], index) => {
      const y = 92 + index * 56;
      d.box(outX, y, 160, 44, kind, name, sub, 11);
      d.arrow(`M ${x(3) + BOX},${ROW + 24} H ${outX - 40} V ${y + 22} H ${outX - 2}`);
    });

    d.rows(
      24,
      292,
      [
        [
          "Each finished state is final. A dependency policy can also finish a blocked task.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 308, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["live", "backend", "blocked", "waits for prerequisites"],
  ["live", "backend", "scheduled", "run time · retry delay · sleep"],
  ["live", "backend", "ready", "waits for a worker"],
  ["live", "focal", "active", "one worker, a lease"],
  ["finished", "store", "succeeded · failed · canceled", "in task_outcome"],
];

/** The state diagram for screens up to 600 px wide: one state on each line. */
export const taskLifecycleNarrow = {
  slug: "task-lifecycle-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
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
      [
        ["A failed attempt with attempts left", 9, "muted", MONO, 400],
        ["retries through scheduled or ready.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
