import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `docs/guides/385-agent-integration.md`. It uses the names of that guide.
 *
 * "Write the four parts of the integration": the deployment installs the schema, and the
 * application only asserts compatibility when it starts. The application enqueues `order.created`
 * in the transaction that inserts `order-42`, with the number of attempts and the time limits. The
 * handler sends the confirmation email in a checkpoint. After the worker completes the task, the
 * application reads it by its identifier.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const title = "The four parts of an integration, and where each one runs";
const description =
  "The deployment installs the Workhorse schema. When the application starts, it asserts that the " +
  "schema is compatible. The application inserts order-42 and enqueues order.created in one " +
  "transaction, with the number of attempts and the time limits. The worker runs the handler, " +
  "which sends the confirmation email in a checkpoint. Then the application reads the task by its " +
  "identifier.";

const zones: readonly (readonly [x: number, width: number, label: string])[] = [
  [24, 192, "DEPLOYMENT"],
  [240, 456, "APPLICATION"],
  [720, 216, "WORKER"],
];

const parts: readonly (readonly [x: number, kind: Kind, name: string, sub: string])[] = [
  [40, "store", "1 · schema install", "workhorse schema install"],
  [256, "backend", "assert compatible", "when the app starts"],
  [476, "focal", "2 · enqueue + 4 · policy", "order-42 and order.created"],
  [736, "backend", "3 · handler", "the email in a checkpoint"],
];

/** The parts diagram: one zone for each place, with the parts in their order. */
export const integrationParts = {
  slug: "agent-integration-parts",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = 76;
    d.arrow(`M 200,${y + 26} H 254`);
    d.arrow(`M 416,${y + 26} H 474`);
    d.arrow(`M 680,${y + 26} H 734`);
    d.arrow(`M 828,${y + 54} V ${y + 96} H 580 V ${y + 120}`);

    zones.forEach(([x, width, label]) => d.zone(x, 48, width, 200, label));
    parts.forEach(([x, kind, name, sub], index) => {
      d.box(x, y, index === 2 ? 204 : 160, 52, kind, name, sub, 11);
    });
    d.box(476, y + 122, 204, 44, "store", "read the task", "by its identifier", 11);
    d.rows(476 + 102, y + 70, [["one transaction · attempts · time limits", 8, "soft", MONO, 400]]);

    d.rows(
      24,
      288,
      [
        [
          "The deployment owns the schema. The application does not install it when it starts.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 304, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["deploy", "store", "1 · schema install", "a deployment step"],
  ["start", "backend", "assert compatible", "no install at startup"],
  ["request", "focal", "2 · enqueue + 4 · policy", "one transaction with order-42"],
  ["worker", "backend", "3 · handler", "the email in a checkpoint"],
  ["after", "store", "read the task", "by its identifier"],
];

/** The parts diagram for screens up to 600 px wide: one part on each line. */
export const integrationPartsNarrow = {
  slug: "agent-integration-parts-narrow",
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
        ["The deployment owns the schema. The", 9, "muted", MONO, 400],
        ["application does not install it.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
