import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `site/content/docs/quickstart.mdx`, step 4. It uses the names of that page.
 *
 * The handler of `order.fulfill` has two checkpoints, `charge` and `label`. Run 1 commits the
 * `charge` checkpoint and then stops the process. The lease of 5 s expires, so the task is
 * available again. Run 2 enqueues with the idempotency key `order:42` and gets the same task. Its
 * handler starts from the top: the `charge` checkpoint returns its stored result, and only the
 * `label` checkpoint runs. The layout is the layout of `signals-wait`.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";
type Cell = readonly [kind: Kind, name: string, sub: string] | undefined;

const columns = [192, 444, 696] as const;
const WIDTH = 240;

function run(
  d: Diagram,
  y: number,
  label: readonly [string, string],
  cells: readonly Cell[],
): void {
  d.rows(
    24,
    y + 14,
    [
      [label[0], 12, "ink", SANS, 600],
      [label[1], 9, "muted", MONO, 400],
    ],
    "start",
  );
  cells.forEach((cell, index) => {
    const x = columns[index]!;
    if (cell === undefined) {
      d.rows(x + WIDTH / 2, y + 27, [["not reached", 9, "soft", MONO, 400]]);
      return;
    }
    d.box(x, y, WIDTH, 48, cell[0], cell[1], cell[2], 11);
  });
}

const title = "The worker stops after the charge, and the next run does not charge again";
const description =
  "Run 1 of crash-demo.ts prints charging card, commits the charge checkpoint, and stops the " +
  "process. The lease of 5 s expires, and the task is available again. Run 2 enqueues with the key " +
  "order:42 and gets the same task. Its handler starts from the top. The charge checkpoint returns " +
  "the stored result and prints nothing. The label checkpoint runs, and the task succeeds.";

/** The crash diagram: each row is one run of the handler, and each column is one part of it. */
export const quickstartCrash = {
  slug: "quickstart-crash",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    ['checkpoint("charge")', 'checkpoint("label")', "return"].forEach((line, index) => {
      d.rows(columns[index]! + WIDTH / 2, 52, [[line, 10, "ink", MONO, 400]]);
    });
    d.divider(192, 936, 68);

    run(
      d,
      84,
      ["Run 1", "node crash-demo.ts"],
      [
        ["focal", "charging card…", "the checkpoint commits"],
        ["external", "the process stops", "before the label"],
        undefined,
      ],
    );

    d.box(192, 148, 744, 40, "external");
    d.rows(564, 172, [
      ["the lease of 5 s expires · the task is available again", 9, "muted", MONO, 400],
    ]);
    d.rows(24, 172, [["the lease", 9, "muted", MONO, 400]], "start");

    d.box(
      192,
      204,
      744,
      40,
      "store",
      "same task",
      "the second run enqueues with the key order:42",
      11,
    );
    d.rows(24, 228, [["the enqueue", 9, "muted", MONO, 400]], "start");

    run(
      d,
      260,
      ["Run 2", "SURVIVED=1"],
      [
        ["store", "stored result", "charging card… does not print"],
        ["backend", "printing shipping label…", "the checkpoint commits"],
        ["backend", "the task succeeds", "chargeId and labelId"],
      ],
    );

    d.rows(
      24,
      348,
      [
        [
          "The card is charged one time. A handler starts from the top, and its named checkpoints do not run again.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 364, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["Run 1", "focal", "charging card…", "the charge checkpoint commits"],
  ["", "external", "the process stops", "the lease of 5 s expires"],
  ["Run 2", "store", "same task, from the top", "charge returns the stored result"],
  ["", "backend", "printing shipping label…", "the task succeeds"],
];

/** The crash diagram for screens up to 600 px wide: one event on each line. */
export const quickstartCrashNarrow = {
  slug: "quickstart-crash-narrow",
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
        ["The card is charged one time, also", 9, "muted", MONO, 400],
        ["after the crash.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
