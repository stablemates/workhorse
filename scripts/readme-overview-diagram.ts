import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The README overview diagram: one dashboard, one schema, and workers in all seven SDKs. The JVM
 * SDK serves Java and Kotlin, and the .NET SDK serves C#.
 *
 * Read from top to bottom:
 *
 * 1. An operator's browser opens the dashboard. Any of the seven SDKs serves it from a route in
 *    your own server (`docs/parity.md`, "Embedded dashboard backend").
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
 * 4. One box per SDK. The JVM box runs Java and Kotlin handlers, and the .NET box runs C#
 *    handlers. "N workers" says that any number of worker processes of that SDK can share the
 *    schema, because PostgreSQL decides each claim (`docs/guides/310-workers.md`). Each box has a
 *    solid arrow up for its calls and a dashed arrow down for what it receives. The legend under
 *    the boxes names both.
 *
 * Check each fact against its source before you change a label.
 */

const SDKS = ["TypeScript", "Python", "Go", "Rust", "Ruby", "JVM", ".NET"] as const;
const COLUMN_WIDTH = 120;
const columns = SDKS.map((_, index) => 24 + index * 132);
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

    d.arrow("M 160,92 H 260");
    d.arrow("M 480,156 V 188");
    d.arrow("M 480,156 V 124");
    for (const x of columns) {
      const cx = x + COLUMN_WIDTH / 2;
      d.arrow(`M ${cx - 12},400 V 352`);
      d.arrow(`M ${cx + 12},348 V 396`, { dashed: true });
    }

    d.zone(232, 40, 496, 104, "YOUR SERVER · YOUR LOGIN · ANY OF 7 SDKS");
    d.zone(24, 168, 912, 204, "POSTGRESQL");

    d.box(24, 64, 136, 56, "external", "Operator", "browser");
    d.box(
      264,
      64,
      432,
      56,
      "focal",
      "One dashboard",
      "mounted on a route you choose · no extra service",
    );
    d.box(48, 192, 864, 156, "store");
    d.divider(64, 896, 244);
    d.divider(64, 896, 296);
    d.rows(480, 214, [
      ["One schema · one protocol", 12, "ink", SANS, 600],
      [
        "versioned SQL functions · the same calls from the dashboard and all 7 SDKs",
        9,
        "muted",
        MONO,
        400,
      ],
    ]);
    d.rows(480, 266, [
      ["Durable task state and history", 12, "ink", SANS, 600],
      [
        "attempts · events · checkpoints · waits · signals · progress · schedules · task groups",
        9,
        "muted",
        MONO,
        400,
      ],
    ]);
    d.rows(480, 318, [
      ["Flow control at claim", 12, "ink", SANS, 600],
      [
        "priority · queue and keyed concurrency limits · rate limits · budgets across queues · queue pause",
        9,
        "muted",
        MONO,
        400,
      ],
    ]);
    SDKS.forEach((name, index) => {
      d.box(columns[index]!, 400, COLUMN_WIDTH, 48, "backend", name, "N workers", 11);
    });

    d.label(196, 72, "HTTPS");
    d.arrow("M 24,476 H 52");
    d.text(60, 479, "claim · heartbeat · complete · fail");
    d.arrow("M 300,476 H 328", { dashed: true });
    d.text(336, 479, "task · payload · fence token");

    return d.render(this.slug, 960, 504, this.title, description);
  },
};

/**
 * The same diagram for screens up to 600 px wide. It is 400 px wide, so a phone shows it at almost
 * full size: the subtitles wrap to two lines in a larger font, and the SDK boxes are narrower. The
 * boxes have no room for "N workers", so a legend line under them says it.
 */
export const readmeOverviewNarrow = {
  slug: "readme-overview-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);

    d.arrow("M 104,86 H 136");
    d.arrow("M 256,140 V 172");
    d.arrow("M 256,140 V 116");
    SDKS.forEach((_, index) => {
      const cx = 24 + index * 50 + 22;
      d.arrow(`M ${cx - 8},436 V 384`);
      d.arrow(`M ${cx + 8},380 V 432`, { dashed: true });
    });

    d.zone(124, 40, 264, 88, "YOUR SERVER · YOUR LOGIN · ANY OF 7 SDKS");
    d.zone(12, 152, 376, 252, "POSTGRESQL");

    d.box(24, 60, 80, 52, "external", "Operator", "browser", 11);
    d.box(140, 60, 232, 52, "focal", "One dashboard", "on a route you choose · no extra service");
    d.box(24, 176, 352, 204, "store");
    d.divider(40, 360, 244);
    d.divider(40, 360, 312);
    d.rows(200, 198, [
      ["One schema · one protocol", 13, "ink", SANS, 600],
      ["versioned SQL functions · the same calls", 10, "muted", MONO, 400],
      ["from the dashboard and all 7 SDKs", 10, "muted", MONO, 400],
    ]);
    d.rows(200, 266, [
      ["Durable task state and history", 13, "ink", SANS, 600],
      ["attempts · events · checkpoints · waits", 10, "muted", MONO, 400],
      ["signals · progress · schedules · task groups", 10, "muted", MONO, 400],
    ]);
    d.rows(200, 334, [
      ["Flow control at claim", 13, "ink", SANS, 600],
      ["priority · queue and keyed concurrency limits", 10, "muted", MONO, 400],
      ["rate limits · budgets across queues · queue pause", 10, "muted", MONO, 400],
    ]);
    SDKS.forEach((name, index) => {
      d.box(24 + index * 50, 436, 46, 36, "backend", name, undefined, 8);
    });

    d.text(24, 495, "each SDK box: N workers");
    d.arrow("M 24,512 H 52");
    d.text(60, 515, "claim · heartbeat · complete · fail");
    d.arrow("M 24,530 H 52", { dashed: true });
    d.text(60, 533, "task · payload · fence token");

    return d.render(this.slug, 400, 548, title, description);
  },
};
