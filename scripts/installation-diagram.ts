import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `site/content/docs/installation.mdx`. It uses the names of that page.
 *
 * "Verify the schema before the new release starts": the deployment step migrates the schema with
 * the tool at the version of the application, then runs `workhorse schema status --json`. The
 * command exits with 1 if this build refuses the schema, and then the deployment stops. Each
 * runtime process checks the schema when it starts, reads the installed version, and changes
 * nothing. During a rolling deployment, the processes of the earlier release find the state `ahead`
 * and continue, because a migration inside a major line only adds.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const title = "Migrate, check the status, then start the new release";
const description =
  "A deployment step runs workhorse schema migrate with the tool at the version of the application. " +
  "Then it runs workhorse schema status --json. If the command exits with 1, the deployment stops. " +
  "If it exits with 0, the new release starts, and each of its processes checks the schema without " +
  "a change. Processes of the earlier release find the state ahead and continue.";

const steps: readonly (readonly [kind: Kind, name: string, sub: string])[] = [
  ["store", "1 · schema migrate", "the tool at the app version"],
  ["focal", "2 · schema status --json", "exit 0 or exit 1"],
  ["backend", "3 · start the new release", "after exit 0"],
  ["backend", "startup check", "reads the version · no change"],
];

const BOX = 204;
const GAP = 32;
const x = (index: number): number => 24 + index * (BOX + GAP);

/** The order diagram: the deployment steps in one row, the stop below the status check. */
export const installationOrder = {
  slug: "installation-order",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = 76;
    d.zone(16, 48, x(2) - 28, 132, "DEPLOYMENT STEP");
    d.zone(x(2) - 8, 48, 936 - x(2) + 16, 132, "EACH PROCESS OF THE NEW RELEASE");
    for (let index = 0; index < steps.length - 1; index += 1) {
      d.arrow(`M ${x(index) + BOX},${y + 26} H ${x(index + 1) - 2}`);
    }
    d.arrow(`M ${x(1) + BOX / 2},${y + 52} V ${y + 128}`, { dashed: true });
    steps.forEach(([kind, name, sub], index) => {
      d.box(x(index), y, BOX, 52, kind, name, sub, 11);
    });
    d.label(x(1) + BOX / 2, y + 74, "EXIT 1");
    d.box(
      x(0),
      y + 130,
      x(1) + BOX - x(0),
      44,
      "external",
      "the deployment stops",
      "write schema.refusal to the log",
      11,
    );
    d.box(
      x(2),
      y + 130,
      x(3) + BOX - x(2),
      44,
      "store",
      "earlier release · state ahead",
      "its processes continue",
      11,
    );

    d.rows(
      24,
      y + 212,
      [
        [
          "A runtime process checks the schema. It does not install it, so it needs no permission to create objects.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, y + 228, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["deploy", "store", "schema migrate", "the tool at the app version"],
  ["deploy", "focal", "schema status --json", "exit 1 stops the deployment"],
  ["release", "backend", "start the new release", "after exit 0"],
  ["process", "backend", "startup check", "reads the version · no change"],
];

/** The order diagram for screens up to 600 px wide: one step on each line. */
export const installationOrderNarrow = {
  slug: "installation-order-narrow",
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
        ["A runtime process checks the schema.", 9, "muted", MONO, 400],
        ["It does not install it.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
