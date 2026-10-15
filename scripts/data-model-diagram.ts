import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `docs/architecture/data-model.md`. It replaces the Mermaid entity diagram and keeps
 * its 14 relations. The column types of each table are in the `Column types` subsection of the
 * section of that table.
 *
 * `task` has eleven relations: retained `enqueue_idempotency` keys (0..n), the live `task_runtime`
 * (0..1), the terminal `task_outcome` (0..1), the operator projection `task_query` (exactly 1),
 * `task_redrive` as the failed source (0..n) and as the redrive target (0..1), restart boundaries
 * in `task_checkpoint` (0..n), the latest `task_progress` (0..1), timer boundaries in `task_wait`
 * (0..n), the `task_event` rows it emits (0..n), and the `attempt_history` rows of its closed
 * attempts (0..n). `schedule_definition` fires `schedule_occurrence` rows (0..n), and each
 * occurrence enqueues at most one `task`. `rate_limit_policy` owns `rate_limit_bucket` token state
 * (0..n). `concurrency_policy` and `admission_shard` have no relation in the diagram.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const title = "The task table and the tables that hang from it";
const description =
  "task owns retained enqueue_idempotency keys, at most one live task_runtime row, at most one " +
  "terminal task_outcome row, exactly one task_query projection, task_redrive edges as the failed " +
  "source and at most one as the redrive target, task_checkpoint restart boundaries, at most one " +
  "task_progress row, task_wait timer boundaries, the task_event rows it emits, and the " +
  "attempt_history rows of its closed attempts. schedule_definition fires schedule_occurrence " +
  "rows, and each occurrence enqueues at most one task. rate_limit_policy owns rate_limit_bucket " +
  "token state. concurrency_policy and admission_shard are queue tables without a relation.";

const left: readonly (readonly [name: string, sub: string])[] = [
  ["enqueue_idempotency", "0..n · retained enqueue keys"],
  ["task_runtime", "0..1 · live lifecycle"],
  ["task_outcome", "0..1 · terminal lifecycle"],
  ["task_query", "exactly 1 · operator projection"],
  ["task_redrive", "0..n failed source · 0..1 target"],
];

const right: readonly (readonly [name: string, sub: string])[] = [
  ["task_checkpoint", "0..n · restart boundaries"],
  ["task_progress", "0..1 · latest progress"],
  ["task_wait", "0..n · timer boundaries"],
  ["task_event", "0..n · emits"],
  ["attempt_history", "0..n · closes attempts"],
];

const ROW = 60;
const TOP = 48;
const SIDE = 272;
const TASK_X = 360;
const TASK_W = 240;

/** The relations diagram: task in the middle, the schedule chain below, the queue tables last. */
export const dataModelRelations = {
  slug: "data-model-relations",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const taskBottom = TOP + 4 * ROW + 44;
    left.forEach(([name, sub], index) => {
      const y = TOP + index * ROW;
      d.arrow(`M ${TASK_X},${y + 22} H ${24 + SIDE + 2}`);
      d.box(
        24,
        y,
        SIDE,
        44,
        name === "task_runtime" || name === "task_outcome" ? "backend" : "store",
        name,
        sub,
        11,
      );
    });
    right.forEach(([name, sub], index) => {
      const y = TOP + index * ROW;
      d.arrow(`M ${TASK_X + TASK_W},${y + 22} H ${936 - SIDE - 2}`);
      d.box(936 - SIDE, y, SIDE, 44, "store", name, sub, 11);
    });
    d.box(TASK_X, TOP, TASK_W, taskBottom - TOP, "focal", "task", "stable identity", 13);

    const chainY = taskBottom + 52;
    d.box(24, chainY, 240, 44, "backend", "schedule_definition", "one row for each schedule", 11);
    d.arrow(`M 264,${chainY + 22} H ${TASK_X - 2}`);
    d.label((264 + TASK_X) / 2, chainY + 16, "fires 0..n");
    d.box(
      TASK_X,
      chainY,
      TASK_W,
      44,
      "backend",
      "schedule_occurrence",
      "one row for each second",
      11,
    );
    d.arrow(`M ${TASK_X + TASK_W / 2},${chainY} V ${taskBottom + 2}`);
    d.label(TASK_X + TASK_W / 2, taskBottom + 14, "enqueues 0..1 task");

    const zoneY = chainY + 84;
    d.zone(16, zoneY, 928, 92, "QUEUE TABLES · keyed by queue_name");
    const qy = zoneY + 28;
    d.box(32, qy, 200, 44, "store", "concurrency_policy", "dispatch budget", 11);
    d.box(256, qy, 184, 44, "store", "rate_limit_policy", "token bucket rules", 11);
    d.arrow(`M 440,${qy + 22} H 518`);
    d.label(480, qy + 16, "owns 0..n");
    d.box(520, qy, 184, 44, "store", "rate_limit_bucket", "token state", 11);
    d.box(728, qy, 200, 44, "store", "admission_shard", "shares for concurrent claims", 11);

    d.rows(
      24,
      zoneY + 124,
      [
        [
          "After a committed transition, exactly one of task_runtime and task_outcome exists for each task.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, zoneY + 140, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["identity", "focal", "task", "stable identity"],
  ["life", "backend", "task_runtime · task_outcome", "0..1 each · exactly one exists"],
  ["reads", "store", "task_query · enqueue_idempotency", "1 projection · 0..n keys"],
  ["durable", "store", "task_checkpoint · task_wait", "0..n · task_progress 0..1"],
  ["history", "store", "task_event · attempt_history", "0..n each"],
  ["redrive", "store", "task_redrive", "0..n source · 0..1 target"],
  ["schedule", "backend", "schedule_definition", "fires schedule_occurrence"],
  ["queue", "store", "rate_limit_policy", "owns rate_limit_bucket"],
];

/** The relations diagram for screens up to 600 px wide: one group of tables on each line. */
export const dataModelRelationsNarrow = {
  slug: "data-model-relations-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const pitch = 56;
    events.forEach(([label, kind, name, sub], index) => {
      const top = 24 + index * pitch;
      d.text(24, top + 25, label, { color: "ink" });
      d.box(112, top, 264, 42, kind, name, sub, 11);
    });
    const footerY = 24 + events.length * pitch + 8;
    d.rows(
      24,
      footerY,
      [
        ["Each table section ends with its", 9, "muted", MONO, 400],
        ["column types.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
