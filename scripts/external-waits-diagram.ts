import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The external waits diagram of `docs/guides/130-durable-waits.md`, "Wait for an external result".
 * It uses the names of that guide.
 *
 * The order handler calls `ctx.waitForSignal("provider-event")`, and Workhorse releases the lease.
 * The application calls `Queue.sendSignal`, and Workhorse stores the payload and sets the task to
 * `ready`. A worker calls the handler from the first line; the signal wait returns the payload, and
 * the handler calls `ctx.waitForHuman("operator-review", …)`. An operator tool calls
 * `Queue.completeHumanWait`. Workhorse calls the handler again, and each wait returns its stored
 * value.
 *
 * Check each fact against its source before you change a label.
 */

const externalTitle = "Each external wait releases the worker until a value arrives";
const externalDescription =
  "The order handler waits for a signal, and no worker holds the task. The application calls " +
  "sendSignal, and Workhorse stores the payload and sets the task to ready. A worker runs the " +
  "handler from the first line. The signal wait returns the payload, and the handler waits for an " +
  "operator. An operator tool calls completeHumanWait. A worker runs the handler again, and each " +
  "wait returns its stored value.";

/** Column `index` of five. */
const col = (index: number): number => 200 + index * 147;
const colWidth = 139;

export const externalWaits = {
  slug: "external-waits",
  title: externalTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);

    d.arrow(`M ${col(1) + colWidth / 2},224 V 116`);
    d.arrow(`M ${col(3) + colWidth / 2},300 V 116`);

    ["first run", "webhook", "second run", "decision", "third run"].forEach((name, index) => {
      d.rows(col(index) + colWidth / 2, 44, [[name, 8, "soft", MONO, 400]]);
    });
    d.divider(col(0), 936, 52);

    d.text(24, 96, "task", { size: 10, color: "ink" });
    d.text(24, 172, "handler", { size: 10, color: "ink" });
    d.text(24, 248, "application", { size: 10, color: "ink" });
    d.text(24, 324, "operator", { size: 10, color: "ink" });

    d.box(col(0), 72, col(1) - 8 - col(0), 40, "store", "scheduled", "no owner", 11);
    d.box(col(1), 72, colWidth, 40, "store", "ready", "payload stored", 11);
    d.box(col(2), 72, col(3) - 8 - col(2), 40, "store", "scheduled", "no owner", 11);
    d.box(col(3), 72, colWidth, 40, "store", "ready", "decision stored", 11);
    d.box(col(4), 72, colWidth, 40, "store", "active", "a worker runs it", 11);

    d.box(col(0), 148, colWidth, 40, "backend", "waitForSignal", "releases the lease", 11);
    d.box(col(2), 148, colWidth, 40, "backend", "signal returns", "then waitForHuman", 11);
    d.box(col(4), 148, colWidth, 40, "focal", "both waits return", "their stored values", 11);

    d.box(col(1), 224, colWidth, 40, "external", "sendSignal", "after the webhook", 11);
    d.box(col(3), 300, colWidth, 40, "external", "completeHumanWait", "an operator decides", 11);

    d.rows(
      24,
      380,
      [
        [
          "Each run starts at the first line of the handler. A repeated delivery does not resume the task.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );

    return d.render(this.slug, 960, 396, externalTitle, externalDescription);
  },
};

type Kind = "focal" | "backend" | "store" | "external";

const externalEvents: readonly (readonly [step: string, kind: Kind, name: string, sub: string])[] =
  [
    ["first run", "backend", "handler: waitForSignal", "releases the lease"],
    ["webhook", "external", "application: sendSignal", "payload stored · task ready"],
    ["second run", "backend", "the signal wait returns", "then waitForHuman"],
    ["decision", "external", "operator: completeHumanWait", "decision stored · task ready"],
    ["third run", "focal", "both waits return", "their stored values"],
  ];

/** The external waits diagram for screens up to 600 px wide: one event on each line. */
export const externalWaitsNarrow = {
  slug: "external-waits-narrow",
  title: externalTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const pitch = 56;

    externalEvents.forEach(([step, kind, name, sub], index) => {
      const top = 24 + index * pitch;
      if (index > 0) d.arrow(`M 240,${top - 14} V ${top - 2}`);
      d.text(24, top + 25, step, { color: "ink" });
      d.box(104, top, 272, 42, kind, name, sub, 11);
    });

    const footerY = 24 + externalEvents.length * pitch + 8;
    d.rows(
      24,
      footerY,
      [
        ["Each run starts at the first line of the", 9, "muted", MONO, 400],
        ["handler. A repeated delivery does not", 9, "muted", MONO, 400],
        ["resume the task.", 9, "muted", MONO, 400],
      ],
      "start",
    );

    return d.render(this.slug, 400, footerY + 47, externalTitle, externalDescription);
  },
};
