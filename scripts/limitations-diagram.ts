import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `site/content/docs/limitations.mdx`. It uses the names of that page.
 *
 * "Run the schema tools from the TypeScript package": Python, Go, Rust, and Ruby have
 * transactional queue clients, complete worker runtimes, and `Admin` operator clients. Schema
 * installation and migration, the `workhorse` admin CLI, and the TUI are only in the TypeScript
 * package. This limit stays at 1.0.0. The workaround runs the CLI as a deployment step.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const title = "Each language runs the queue; only TypeScript changes the schema";
const description =
  "TypeScript, Python, Go, Rust, and Ruby each have a transactional queue client, a complete " +
  "worker runtime, and an Admin operator client. Schema installation and migration, the workhorse " +
  "admin CLI, and the TUI are only in the TypeScript package. A deployment with many languages " +
  "runs the CLI as a deployment step.";

const languages = ["TypeScript", "Python", "Go", "Rust", "Ruby"] as const;
const parts = ["queue client", "worker runtime", "Admin client", "schema tools · CLI · TUI"];

const COL = 176;
const WIDTH = 176;
const GAP = 12;
const x = (index: number): number => COL + index * (WIDTH + GAP);

/** The language diagram: one row for each language, one column for each part. */
export const languageParts = {
  slug: "limitations-language-parts",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    parts.forEach((part, index) => {
      d.rows(x(index) + WIDTH / 2, 44, [[part, 8, "soft", MONO, 400]]);
    });
    d.divider(COL, x(3) + WIDTH, 52);
    languages.forEach((language, row) => {
      const y = 68 + row * 48;
      d.rows(24, y + 23, [[language, 11, "ink", SANS, 600]], "start");
      for (let col = 0; col < 3; col += 1) {
        d.box(x(col), y, WIDTH, 36, "backend", "yes", undefined, 11);
      }
      if (row === 0) {
        d.box(x(3), y, WIDTH, 36, "focal", "yes", undefined, 11);
      } else {
        d.rows(x(3) + WIDTH / 2, y + 22, [["not in this SDK", 9, "soft", MONO, 400]]);
      }
    });
    const footerY = 68 + languages.length * 48 + 20;
    d.rows(
      24,
      footerY,
      [
        [
          "Run the TypeScript CLI as a deployment step. Pin it to the SDK version of your application.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, footerY + 16, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["TypeScript", "focal", "queue · worker · Admin", "and the schema tools, CLI, TUI"],
  ["Python", "backend", "queue · worker · Admin", "no schema tools"],
  ["Go", "backend", "queue · worker · Admin", "no schema tools"],
  ["Rust", "backend", "queue · worker · Admin", "no schema tools"],
  ["Ruby", "backend", "queue · worker · Admin", "no schema tools"],
];

/** The language diagram for screens up to 600 px wide: one language on each line. */
export const languagePartsNarrow = {
  slug: "limitations-language-parts-narrow",
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
        ["Run the TypeScript CLI as a", 9, "muted", MONO, 400],
        ["deployment step.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
