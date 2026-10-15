import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of the architecture reference: `docs/architecture/schema-and-protocol.md` and
 * `docs/architecture/operations.md`. They use only real identifiers.
 *
 * Schema compatibility: `schemaCompatibilityRefusal` in `typescript/core/src/schema.ts` tests in
 * this order. A missing schema version is `schema-not-installed`. A version below
 * `MINIMUM_SCHEMA_VERSION` is `schema-too-old`. A client protocol below `MINIMUM_PROTOCOL_VERSION`
 * is `client-protocol-too-old`, and above `MAXIMUM_PROTOCOL_VERSION` is `client-protocol-too-new`.
 * If the schema declares served protocols and the client protocol is not one of them, a client
 * protocol below the oldest served one is `schema-too-new`, and any other is `schema-too-old`.
 *
 * Worker shutdown: the first `SIGINT` or `SIGTERM` sets readiness to false and calls `stop()` on
 * every Worker. The workers send no more claims, active handlers continue with their heartbeat
 * batch, and the adapter resources close after every run loop finishes. A second signal exits with
 * the conventional signal code. A missed deadline (`shutdownTimeoutMs`, 25,000 ms by default)
 * exits with code 1.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

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

const compatibilityTitle =
  "schemaCompatibilityRefusal tests in this order; the first failed test decides";
const compatibilityDescription =
  "A missing schema version gives schema-not-installed. A version below MINIMUM_SCHEMA_VERSION " +
  "gives schema-too-old. A client protocol below MINIMUM_PROTOCOL_VERSION gives " +
  "client-protocol-too-old, and above MAXIMUM_PROTOCOL_VERSION gives client-protocol-too-new. If " +
  "the schema declares served protocols without the client protocol, a lower client protocol gives " +
  "schema-too-new, and a higher one gives schema-too-old. Otherwise the schema is compatible.";

const checks: readonly (readonly [
  check: readonly [string, string],
  label: string,
  result: readonly [string, string],
])[] = [
  [["schema version", "readable"], "MISSING", ["schema-not-installed", "reinstall"]],
  [["schema version", "≥ the minimum"], "BELOW", ["schema-too-old", "migrate"]],
  [["client protocol", "≥ the minimum"], "BELOW", ["client-protocol-too-old", "other build"]],
  [["client protocol", "≤ the maximum"], "ABOVE", ["client-protocol-too-new", "other build"]],
  [["served set", "if declared"], "NOT SERVED", ["schema-too-new", "or schema-too-old"]],
];

const BOX = 140;
const GAP = 18;
const x = (index: number): number => 24 + index * (BOX + GAP);

/** The compatibility diagram: the tests in one row, the refusal of each failed test below it. */
export const schemaCompatibility = {
  slug: "schema-compatibility",
  title: compatibilityTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = 48;
    const below = y + 128;
    checks.forEach((_, index) => {
      d.arrow(`M ${x(index) + BOX},${y + 26} H ${x(index + 1) - 2}`);
      d.arrow(`M ${x(index) + BOX / 2},${y + 52} V ${below - 2}`, { dashed: true });
    });
    checks.forEach(([[name, sub], label, [result, resultSub]], index) => {
      d.box(x(index), y, BOX, 52, "backend", name, sub, 10);
      d.label(x(index) + BOX / 2, y + 90, label);
      d.box(x(index), below, BOX, 48, "external", result, resultSub, 10);
    });
    d.box(x(5), y, 936 - x(5), 52, "focal", "compatible", "returns null", 11);
    d.rows(
      24,
      below + 80,
      [
        [
          "The Go and Python checks return the same five codes. Go applies no upper bound to the schema version.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, below + 96, compatibilityTitle, compatibilityDescription);
  },
};

/** The compatibility diagram for screens up to 600 px wide: one test on each line. */
export const schemaCompatibilityNarrow = {
  slug: "schema-compatibility-narrow",
  title: compatibilityTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["1", "external", "no schema version", "schema-not-installed"],
        ["2", "external", "below the minimum", "schema-too-old"],
        ["3", "external", "protocol below the range", "client-protocol-too-old"],
        ["4", "external", "protocol above the range", "client-protocol-too-new"],
        ["5", "external", "not in the served set", "schema-too-new or -too-old"],
        ["else", "focal", "compatible", "returns null"],
      ],
      ["The first failed test decides."],
    );
    return d.render(this.slug, 400, height, compatibilityTitle, compatibilityDescription);
  },
};

const shutdownTitle =
  "A worker process drains after the first signal and exits early only on a failure";
const shutdownDescription =
  "The first SIGINT or SIGTERM sets readiness to false and calls stop() on every Worker. The " +
  "workers send no more claims. Active handlers continue, and their heartbeat batch continues. The " +
  "adapter resources close after every run loop finishes. A second signal exits with the " +
  "conventional signal code. A missed deadline, shutdownTimeoutMs with 25,000 ms by default, exits " +
  "with code 1.";

const STEP = 168;
const STEP_GAP = 18;
const stepX = (index: number): number => 24 + index * (STEP + STEP_GAP);

const shutdownSteps: readonly (readonly [kind: Kind, name: string, sub: string])[] = [
  ["external", "SIGINT or SIGTERM", "the first signal"],
  ["backend", "readiness false", "stop() on every Worker"],
  ["focal", "handlers drain", "heartbeats · no claims"],
  ["backend", "adapter closes", "after every run loop"],
  ["store", "the process exits", "the drain is complete"],
];

/** The shutdown diagram: the drain in one row, the two failures below the drain. */
export const workerShutdown = {
  slug: "worker-shutdown",
  title: shutdownTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = 48;
    shutdownSteps.forEach(([kind, name, sub], index) => {
      if (index > 0) d.arrow(`M ${stepX(index - 1) + STEP},${y + 26} H ${stepX(index) - 2}`);
      d.box(stepX(index), y, STEP, 52, kind, name, sub, 11);
    });
    const drain = stepX(2) + STEP / 2;
    d.arrow(`M ${drain - 40},${y + 52} V ${y + 92} H ${stepX(1) + STEP / 2} V ${y + 126}`, {
      dashed: true,
    });
    d.arrow(`M ${drain + 40},${y + 52} V ${y + 92} H ${stepX(3) + STEP / 2} V ${y + 126}`, {
      dashed: true,
    });
    d.box(stepX(1), y + 128, STEP, 52, "external", "second signal", "the signal exit code", 11);
    d.box(
      stepX(3),
      y + 128,
      STEP,
      52,
      "external",
      "missed deadline",
      "25,000 ms default · code 1",
      11,
    );
    d.rows(
      24,
      y + 212,
      [
        [
          "A hard stop leaves active leases to fenced expiry recovery. A process stop does not cancel a task.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, y + 228, shutdownTitle, shutdownDescription);
  },
};

/** The shutdown diagram for screens up to 600 px wide: one step on each line. */
export const workerShutdownNarrow = {
  slug: "worker-shutdown-narrow",
  title: shutdownTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["signal", "external", "SIGINT or SIGTERM", "the first signal"],
        ["stop", "backend", "readiness false", "stop() on every Worker"],
        ["drain", "focal", "handlers drain", "heartbeats · no claims"],
        ["close", "backend", "adapter closes", "after every run loop"],
      ],
      ["A second signal: the signal exit code.", "A missed deadline: exit code 1."],
    );
    return d.render(this.slug, 400, height, shutdownTitle, shutdownDescription);
  },
};
