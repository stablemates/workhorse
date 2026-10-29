import { Diagram, SANS, type Theme } from "./diagram-svg.js";

/**
 * The README overview diagram: one dashboard, one schema, and workers in all seven SDKs. The JVM
 * SDK serves Java and Kotlin, and the .NET SDK serves C#.
 *
 * Read from top to bottom:
 *
 * 1. An operator opens the dashboard. Any of the seven SDKs serves it from a route in your own
 *    server (`docs/parity.md`, "Embedded dashboard backend").
 * 2. The dashboard and the schema exchange reads and operator actions. One arrow with a head at
 *    each end shows that exchange.
 * 3. One block in PostgreSQL holds three rows:
 *    - the protocol: versioned SQL functions that the dashboard and every SDK call;
 *    - durable state and history: `attempt_history`, `task_event`, `task_checkpoint`,
 *      `task_wait`, `task_signal_wait`, `task_progress`, `schedule_definition`, and `task_group`
 *      under `sql/`;
 *    - the controls that PostgreSQL applies when a worker claims a task: priority, queue and
 *      keyed concurrency policies, rate limits, budgets, and queue pause
 *      (`docs/guides/240-concurrency-policies.md`, `docs/guides/250-rate-limits.md`). Debounce
 *      and throttle act at enqueue, so this row leaves them out.
 *    Each row names a subset, so the diagram stays short. The description lists them in full.
 * 4. One pair of arrows joins PostgreSQL and the workers: a solid arrow up for the calls of a
 *    worker and a dashed arrow down for what it receives. Their labels replace a legend.
 * 5. One box per SDK in a region for the workers. Any number of worker processes of an SDK can
 *    share the schema, because PostgreSQL decides each claim (`docs/guides/310-workers.md`).
 *
 * Check each fact against its source before you change a label.
 */

const SDKS = ["TypeScript", "Python", "Go", "Rust", "Ruby", "JVM", ".NET"] as const;
const COLUMN_WIDTH = 112;
const columns = SDKS.map((_, index) => 52 + index * 124);
const title = "One protocol for your workers and your dashboard";
const description =
  "Any of the seven SDKs serves one dashboard from a route in your own server. The dashboard and " +
  "workers in TypeScript, Python, Go, Rust, Ruby, Java, Kotlin, and C# call the same versioned SQL " +
  "functions. PostgreSQL holds durable task state and history, and applies priority, " +
  "concurrency limits, rate limits, budgets, and queue pause when a worker claims a task.";

export const readmeOverview = {
  slug: "readme-overview",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);

    d.arrow("M 188,52 H 319");
    d.arrow("M 480,98 V 116");
    d.arrow("M 480,98 V 81");
    d.arrow("M 468,376 V 329");
    d.arrow("M 492,328 V 375", { dashed: true });

    d.zone(24, 116, 912, 212, "POSTGRESQL");
    d.zone(24, 376, 912, 84, "WORKERS · ANY NUMBER OF PROCESSES");

    d.box(24, 28, 164, 48, "external", "Operator");
    d.box(320, 24, 320, 56, "focal", "Dashboard", "A route in your own server");
    d.box(48, 140, 864, 164, "store");
    d.divider(64, 896, 194);
    d.divider(64, 896, 248);
    d.rows(480, 164, [
      ["One schema, one protocol", 12, "ink", SANS, 500],
      ["Versioned SQL functions that the dashboard and every SDK call", 10, "soft", SANS, 400],
    ]);
    d.rows(480, 218, [
      ["Durable state and history", 12, "ink", SANS, 500],
      ["Attempts, events, checkpoints, waits, and schedules", 10, "soft", SANS, 400],
    ]);
    d.rows(480, 272, [
      ["Flow control at claim", 12, "ink", SANS, 500],
      ["Priority, concurrency limits, rate limits, and queue pause", 10, "soft", SANS, 400],
    ]);
    d.text(456, 355, "claim · heartbeat · complete · fail", { size: 10, anchor: "end" });
    d.text(504, 355, "task · payload · fence token", { size: 10 });
    SDKS.forEach((name, index) => {
      d.box(columns[index]!, 400, COLUMN_WIDTH, 40, "backend", name, undefined, 11);
    });

    return d.render(this.slug, 960, 484, this.title, description);
  },
};

/**
 * The same diagram for screens up to 600 px wide, and for the first page of the docs. It is 400 px
 * wide, so a phone shows it at almost full size. The subtitles wrap to two lines, and the SDK boxes
 * sit in two rows.
 */
export const readmeOverviewNarrow = {
  slug: "readme-overview-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);

    d.arrow("M 112,52 H 147");
    d.arrow("M 262,98 V 116");
    d.arrow("M 262,98 V 81");
    d.arrow("M 268,416 V 361");
    d.arrow("M 292,360 V 415", { dashed: true });

    d.zone(12, 116, 376, 244, "POSTGRESQL");
    d.zone(12, 416, 376, 128, "WORKERS · ANY NUMBER OF PROCESSES");

    d.box(24, 28, 88, 48, "external", "Operator", undefined, 11);
    d.box(148, 24, 228, 56, "focal", "Dashboard", "A route in your own server");
    d.box(24, 136, 352, 204, "store");
    d.divider(40, 360, 204);
    d.divider(40, 360, 272);
    d.rows(200, 160, [
      ["One schema, one protocol", 13, "ink", SANS, 500],
      ["Versioned SQL functions that the", 10, "soft", SANS, 400],
      ["dashboard and every SDK call", 10, "soft", SANS, 400],
    ]);
    d.rows(200, 228, [
      ["Durable state and history", 13, "ink", SANS, 500],
      ["Attempts, events, checkpoints,", 10, "soft", SANS, 400],
      ["waits, and schedules", 10, "soft", SANS, 400],
    ]);
    d.rows(200, 296, [
      ["Flow control at claim", 13, "ink", SANS, 500],
      ["Priority, concurrency limits,", 10, "soft", SANS, 400],
      ["rate limits, and queue pause", 10, "soft", SANS, 400],
    ]);
    d.text(256, 384, "claim · heartbeat", { size: 10, anchor: "end" });
    d.text(256, 397, "complete · fail", { size: 10, anchor: "end" });
    d.text(304, 384, "task · payload", { size: 10 });
    d.text(304, 397, "fence token", { size: 10 });
    SDKS.forEach((name, index) => {
      const row = index < 4 ? 0 : 1;
      const column = row === 0 ? index : index - 4;
      const x = row === 0 ? 24 + column * 90 : 69 + column * 90;
      d.box(x, 436 + row * 52, 82, 40, "backend", name, undefined, 11);
    });

    return d.render(this.slug, 400, 568, title, description);
  },
};
