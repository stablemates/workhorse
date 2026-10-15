import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `dashboard/v1/README.md` and `typescript/demo/DEPLOYMENT.md`. Each uses the
 * names of its document.
 *
 * Request handling order: the reference host checks the request host (421), then authorizes the
 * request (401 or 403), then checks schema compatibility (503), then requires a same-origin
 * `Origin` for a mutation (403), then validates the input and runs the procedure. A read-only
 * backend answers `FORBIDDEN` for every mutation.
 *
 * Demo schema step: after the image is built and pushed, the pipeline runs
 * `node dist/prepare-schema.js` in a container from the same image. It installs or migrates the
 * Workhorse schema and the demo tables in every workspace and verifies each one. A refusal exits
 * non-zero and fails the deploy before the container swap. The server asserts compatibility at
 * startup and refuses to open `/up` when the step did not run.
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

function footer(d: Diagram, y: number, line: string): void {
  d.rows(24, y, [[line, 9, "muted", MONO, 400]], "start");
}

// Request handling order ----------------------------------------------------------------------

const requestTitle = "Each owned request passes four checks before its procedure runs";
const requestDescription =
  "The host check refuses another request host with 421. Authorization answers 401 for an " +
  "unauthenticated request and 403 for an unauthorized one. An incompatible schema answers 503. A " +
  "mutation without a same-origin Origin header answers 403. Then the backend validates the input " +
  "and runs the procedure. A read-only backend answers FORBIDDEN for every mutation.";

const checks: readonly (readonly [
  check: readonly [string, string],
  label: string,
  result: readonly [string, string],
])[] = [
  [["host check", "configured host names"], "OTHER HOST", ["421", "Misdirected Request"]],
  [["authorization", "the host application"], "REFUSED", ["401 or 403", "the request is refused"]],
  [["schema", "compatible installation"], "INCOMPATIBLE", ["503", "an error message"]],
  [["same origin", "mutation only"], "NO MATCH", ["403", "same-origin required"]],
];

const BOX = 164;
const GAP = 24;
const x = (index: number): number => 24 + index * (BOX + GAP);

/** The request diagram: the checks in one row, the answer of each failed check below it. */
export const dashboardRequestOrder = {
  slug: "dashboard-request-order",
  title: requestTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = 48;
    const below = y + 128;
    checks.forEach((_, index) => {
      d.arrow(`M ${x(index) + BOX},${y + 26} H ${x(index + 1) - 2}`);
      d.arrow(`M ${x(index) + BOX / 2},${y + 52} V ${below - 2}`, { dashed: true });
    });
    checks.forEach(([[name, sub], label, [result, resultSub]], index) => {
      d.box(x(index), y, BOX, 52, "backend", name, sub, 11);
      d.label(x(index) + BOX / 2, y + 90, label);
      d.box(x(index), below, BOX, 48, "external", result, resultSub, 11);
    });
    d.box(x(4), y, 936 - x(4), 52, "focal", "input validation", "then the procedure", 11);
    footer(
      d,
      below + 80,
      "A read-only backend answers FORBIDDEN for every mutation. The server assigns audit.actor.",
    );
    return d.render(this.slug, 960, below + 96, requestTitle, requestDescription);
  },
};

/** The request diagram for screens up to 600 px wide: one check on each line. */
export const dashboardRequestOrderNarrow = {
  slug: "dashboard-request-order-narrow",
  title: requestTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["1", "external", "host check", "another host: 421"],
        ["2", "external", "authorization", "401 or 403"],
        ["3", "external", "schema compatibility", "incompatible: 503"],
        ["4", "external", "same origin", "a mutation without it: 403"],
        ["5", "focal", "input validation", "then the procedure"],
      ],
      ["A backend must not reorder these", "checks."],
    );
    return d.render(this.slug, 400, height, requestTitle, requestDescription);
  },
};

// Demo schema step ----------------------------------------------------------------------------

const stepTitle = "The demo prepares its schema from the new image before any container starts";
const stepDescription =
  "After the image is built and pushed, the pipeline runs node dist/prepare-schema.js in a " +
  "container from the same image, with the same environment and volumes. It installs or migrates " +
  "the Workhorse schema and the demo tables in every workspace and verifies each one. A refusal " +
  "exits non-zero and fails the deploy before the container swap. After the swap, the server " +
  "asserts compatibility and opens /up only when the step ran.";

const steps: readonly (readonly [kind: Kind, name: string, sub: string])[] = [
  ["backend", "build and push", "the image of the release"],
  ["focal", "prepare-schema.js", "a container from that image"],
  ["backend", "container swap", "only after exit 0"],
  ["store", "server starts", "asserts compatibility · /up"],
];

const STEP = 204;
const STEP_GAP = 30;
const stepX = (index: number): number => 24 + index * (STEP + STEP_GAP);

/** The schema step diagram: the pipeline steps in order, and the failed deploy below. */
export const demoSchemaStep = {
  slug: "demo-schema-step",
  title: stepTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = 48;
    steps.forEach(([kind, name, sub], index) => {
      if (index > 0) d.arrow(`M ${stepX(index - 1) + STEP},${y + 26} H ${stepX(index) - 2}`);
      d.box(stepX(index), y, STEP, 52, kind, name, sub, 11);
    });
    const mid = stepX(1) + STEP / 2;
    d.arrow(`M ${mid},${y + 52} V ${y + 126}`, { dashed: true });
    d.label(mid, y + 84, "A REFUSAL · NON-ZERO EXIT");
    d.box(stepX(1), y + 128, STEP, 48, "external", "the deploy fails", "before the swap", 11);
    footer(
      d,
      y + 208,
      "Nothing prepares a schema at startup. The entry point starts processes only.",
    );
    return d.render(this.slug, 960, y + 224, stepTitle, stepDescription);
  },
};

/** The schema step diagram for screens up to 600 px wide: one step on each line. */
export const demoSchemaStepNarrow = {
  slug: "demo-schema-step-narrow",
  title: stepTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["build", "backend", "build and push", "the image of the release"],
        ["schema", "focal", "prepare-schema.js", "non-zero exit fails the deploy"],
        ["swap", "backend", "container swap", "only after exit 0"],
        ["start", "store", "server starts", "asserts compatibility · /up"],
      ],
      ["Nothing prepares a schema at startup."],
    );
    return d.render(this.slug, 400, height, stepTitle, stepDescription);
  },
};
