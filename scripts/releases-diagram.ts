import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `site/content/docs/releases.mdx`. It uses the names of that page.
 *
 * "Upgrade to the current line to get a fix": each fix ships in a release train, and the location of
 * the defect decides which lines change. A defect in the SQL schema or in the protocol that the SDKs
 * share gives each line the fix. A defect in one SDK gives that line the fix, and each other line
 * publishes the same version with no change (ADR 0106). The fix ships only on the highest published
 * minor release of the current major, with no backports.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const title = "The location of the defect decides which lines change in a release train";
const description =
  "Each fix ships in a release train that publishes the npm packages, Python, Go, Rust, Ruby, " +
  "JVM, and .NET lines at one version. If the defect is in the SQL schema or in the protocol that the SDKs " +
  "share, each line gets the fix. If the defect is in one SDK, for example Python, that line gets " +
  "the fix. Each other line publishes the same version with no change. Each fix ships only on " +
  "the highest published minor release of the current major.";

const lines = ["npm packages", "Python", "Go", "Rust", "Ruby", "JVM", ".NET"] as const;

const rows: readonly (readonly [label: readonly [string, string], released: readonly boolean[]])[] =
  [
    [
      ["schema or protocol", "shared by the SDKs"],
      [true, true, true, true, true, true, true],
    ],
    [
      ["one SDK", "for example Python"],
      [false, true, false, false, false, false, false],
    ],
  ];

// Seven columns of 96 px with 10 px gaps end at x = 940, so the diagram keeps its 960 px width.
const LEFT = 208;
const WIDTH = 96;
const GAP = 10;
const x = (index: number): number => LEFT + index * (WIDTH + GAP);

/** The release diagram: one row for each defect location, one column for each line. */
export const releaseLines = {
  slug: "release-lines",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    lines.forEach((line, index) => {
      d.rows(x(index) + WIDTH / 2, 44, [[line, 8, "soft", MONO, 400]]);
    });
    const right = x(lines.length - 1) + WIDTH;
    d.divider(LEFT, right, 52);
    d.zone(LEFT - 8, 64, right - LEFT + 16, rows.length * 88 - 8, "ONE RELEASE TRAIN · ONE COMMIT");
    rows.forEach(([label, released], row) => {
      const y = 88 + row * 88;
      d.rows(
        24,
        y + 20,
        [
          [label[0], 12, "ink", SANS, 600],
          [label[1], 9, "muted", MONO, 400],
        ],
        "start",
      );
      released.forEach((isReleased, col) => {
        if (isReleased) {
          d.box(x(col), y, WIDTH, 44, "backend", "fix", undefined, 11);
        } else {
          d.rows(x(col) + WIDTH / 2, y + 26, [["version only", 9, "soft", MONO, 400]]);
        }
      });
    });
    const footerY = 88 + rows.length * 88 - 8;
    d.rows(
      24,
      footerY,
      [
        [
          "A fix ships only on the highest minor release of the current major. Workhorse has no backports.",
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
  ["schema", "focal", "release train", "each line, from one commit"],
  ["one SDK", "backend", "fix in that line", "other lines: same version, no change"],
  ["upgrade", "store", "the current line", "no backports"],
];

/** The release diagram for screens up to 600 px wide: one case on each line. */
export const releaseLinesNarrow = {
  slug: "release-lines-narrow",
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
        ["A fix ships only on the highest minor", 9, "muted", MONO, 400],
        ["release of the current major.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
