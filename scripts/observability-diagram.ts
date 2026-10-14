import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `docs/guides/355-observability.md`. It uses the names of that guide.
 *
 * "Read the metrics that each process records": each worker process records counters and
 * durations for its own work, such as `workhorse.tasks.claimed` and the handler outcome. The
 * attributes are the queue, the task type, and the outcome, never a task ID.
 *
 * "Collect database metrics in one service": the shared state in PostgreSQL needs one reader.
 * `WorkhorseMetricsObserver` reads it and records gauges, such as queue depth and the age of ready
 * work. An observer in each of ten replicas exports ten copies of each gauge.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const title = "Each worker records its own metrics, and one service records the database gauges";
const description =
  "Each worker replica records counters and durations for its own work, such as claims and handler " +
  "outcomes, with the queue, task type, and outcome as attributes. One long-lived service runs " +
  "WorkhorseMetricsObserver. It reads the shared state in PostgreSQL and records gauges, such as " +
  "queue depth and the age of ready work. An observer in each replica would export one copy of " +
  "each gauge per replica.";

/** The source diagram: the worker replicas, PostgreSQL, the observer service, and the backend. */
export const metricSources = {
  slug: "observability-sources",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);

    d.arrow("M 344,180 H 370", { dashed: true });
    d.arrow("M 520,112 V 150");
    d.arrow("M 670,84 H 718");
    d.arrow("M 184,264 V 292 H 828 V 254");
    d.label(520, 284, "COUNTERS · DURATIONS");
    d.label(694, 64, "GAUGES");

    d.zone(24, 48, 320, 216, "WORKER REPLICAS · 10");
    d.box(40, 68, 288, 48, "backend", "worker 1", "its own claims and handlers", 11);
    d.box(40, 128, 288, 48, "backend", "worker 2", "its own claims and handlers", 11);
    d.box(40, 188, 288, 48, "backend", "worker 10", "its own claims and handlers", 11);

    d.box(372, 56, 296, 56, "focal", "one service", "WorkhorseMetricsObserver", 11);
    d.box(372, 152, 296, 56, "store", "PostgreSQL", "queues · leases · workers", 11);

    d.box(720, 56, 216, 196, "external", "monitoring backend", "your OpenTelemetry SDK", 11);

    d.rows(
      24,
      332,
      [
        [
          "Run one observer for a database. An observer in each of ten replicas exports ten copies of each gauge.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 348, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["workers", "backend", "each worker replica", "counters and durations of its work"],
  ["service", "focal", "WorkhorseMetricsObserver", "one service for the database"],
  ["reads", "store", "PostgreSQL", "queue depth · age of ready work"],
  ["sends", "external", "monitoring backend", "counters, durations, gauges"],
];

/** The source diagram for screens up to 600 px wide: one part on each line. */
export const metricSourcesNarrow = {
  slug: "observability-sources-narrow",
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
        ["Run one observer for a database, not", 9, "muted", MONO, 400],
        ["one in each worker replica.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
