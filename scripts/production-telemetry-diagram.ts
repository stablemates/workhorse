import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `docs/guides/350-production-telemetry.md`. It uses the names of that guide.
 *
 * "Follow a task from enqueue to execution": the TypeScript queue makes an enqueue span below the
 * HTTP server span of the web request. PostgreSQL stores the trace context of that span next to
 * the payload, and the payload does not change. The claim returns the stored context, and the
 * worker makes it the parent of the handler span. Thus one trace holds the request, the enqueue,
 * and the handler run, 10 minutes later in another process. Workhorse does not store baggage.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const title = "One trace connects the enqueue and the handler run in another process";
const description =
  "At 0 min, a web request has an HTTP server span, and the TypeScript queue makes an enqueue span " +
  "below it. PostgreSQL stores the trace context of the enqueue span next to the payload of the " +
  "invoice.send task. At 10 min, a worker in another process claims the task. The claim returns " +
  "the stored context, and the handler span joins the first trace. Workhorse does not store baggage.";

/** The trace diagram: the spans of each process, and the context that PostgreSQL stores. */
export const traceAcrossQueue = {
  slug: "production-telemetry-trace",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const lane = (y: number, name: string, sub: string): void => {
      d.rows(
        24,
        y + 16,
        [
          [name, 11, "ink", SANS, 600],
          [sub, 9, "muted", MONO, 400],
        ],
        "start",
      );
    };

    d.rows(330, 44, [["0 min", 8, "soft", MONO, 400]]);
    d.rows(800, 44, [["10 min", 8, "soft", MONO, 400]]);
    d.divider(200, 936, 52);

    d.arrow("M 400,160 V 194");
    d.arrow("M 640,218 H 720 V 270");
    d.label(720, 238, "CLAIM RETURNS IT");

    lane(72, "web process", "the request");
    d.box(200, 72, 260, 40, "backend", "HTTP server span", undefined, 11);
    d.box(240, 120, 220, 40, "backend", "enqueue span", "TypeScript queue", 11);

    lane(196, "PostgreSQL", "the task row");
    d.box(
      200,
      196,
      440,
      44,
      "store",
      "trace context next to the payload",
      "the payload does not change",
      11,
    );

    lane(272, "worker process", "another process");
    d.box(664, 272, 272, 44, "focal", "handler span", "parent: the stored context", 11);

    d.rows(
      24,
      356,
      [
        [
          "One trace shows the request, the enqueue, and the handler run. Workhorse does not store baggage.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 372, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["0 min", "backend", "HTTP server span", "the web request"],
  ["", "backend", "enqueue span", "below the request span"],
  ["", "store", "PostgreSQL stores the context", "next to the payload"],
  ["10 min", "focal", "handler span", "parent: the stored context"],
];

/** The trace diagram for screens up to 600 px wide: one step on each line. */
export const traceAcrossQueueNarrow = {
  slug: "production-telemetry-trace-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const pitch = 56;
    events.forEach(([label, kind, name, sub], index) => {
      const top = 24 + index * pitch;
      if (index > 0) d.arrow(`M 248,${top - 14} V ${top - 2}`);
      if (label) d.text(24, top + 25, label, { color: "ink" });
      d.box(112, top, 264, 42, kind, name, sub, 11);
    });
    const footerY = 24 + events.length * pitch + 8;
    d.rows(
      24,
      footerY,
      [
        ["One trace shows the request, the enqueue,", 9, "muted", MONO, 400],
        ["and the handler run in another process.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
