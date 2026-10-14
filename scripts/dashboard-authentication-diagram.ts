import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `docs/guides/370-dashboard-authentication.md`. It uses the names of that guide.
 *
 * "Protect an embedded dashboard with your application login": the dashboard calls the
 * `authorize` callback before it serves anything. The callback reads the application session and
 * returns a principal, or refuses the request, and then the dashboard serves nothing. The dashboard
 * checks that the installed schema is compatible and does not install or change it. An operator
 * action records the actor of the principal.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const title = "The dashboard asks your application who the operator is before it serves anything";
const description =
  "Dana opens /workhorse in the application. The dashboard calls the authorize callback before it " +
  "serves anything. The callback reads the application session and returns a principal that names " +
  "dana. If the callback refuses the request, the dashboard serves nothing. The dashboard checks " +
  "that the installed schema is compatible and does not change it. When Dana cancels a task, the " +
  "dashboard records dana as the operator.";

const steps: readonly (readonly [kind: Kind, name: string, sub: string])[] = [
  ["external", "Dana opens", "/workhorse"],
  ["focal", "authorize callback", "reads the app session"],
  ["store", "principal", "actor: dana"],
  ["backend", "schema check", "compatible · no change"],
  ["backend", "Dana cancels a task", "recorded actor: dana"],
];

const BOX = 160;
const GAP = 28;
const x = (index: number): number => 24 + index * (BOX + GAP);

/** The request flow: five steps in one row, with the refusal below the callback. */
export const dashboardAuthorize = {
  slug: "dashboard-authorize",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = 56;
    for (let index = 0; index < steps.length - 1; index += 1) {
      d.arrow(`M ${x(index) + BOX},${y + 24} H ${x(index + 1) - 2}`);
    }
    d.arrow(`M ${x(1) + BOX / 2},${y + 48} V ${y + 102}`, { dashed: true });
    steps.forEach(([kind, name, sub], index) => {
      d.box(x(index), y, BOX, 48, kind, name, sub, 11);
    });
    d.label(x(1) + BOX / 2, y + 66, "REFUSES");
    d.box(
      x(0),
      y + 104,
      x(2) + BOX - x(0),
      44,
      "external",
      "the dashboard serves nothing",
      "no page, no data",
      11,
    );

    d.rows(
      24,
      y + 188,
      [
        [
          "The application owns the login. The dashboard records the operator that the callback names.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, y + 204, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["request", "external", "Dana opens /workhorse", "nothing is served yet"],
  ["callback", "focal", "authorize", "reads the application session"],
  ["refuses", "external", "the dashboard serves nothing", "no page, no data"],
  ["accepts", "store", "principal: dana", "schema check · no change"],
  ["action", "backend", "Dana cancels a task", "recorded actor: dana"],
];

/** The request flow for screens up to 600 px wide: one step on each line. */
export const dashboardAuthorizeNarrow = {
  slug: "dashboard-authorize-narrow",
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
        ["The application owns the login. The", 9, "muted", MONO, 400],
        ["dashboard records the operator it names.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
