import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/340-redrive.md`. They use the names of that guide.
 *
 * "Redrive one task": redrive creates a new task from a dead letter in one transaction and does not
 * change the failed task. The new task copies the fields that define the work and none of the state
 * of the failed run. It does not get the deadline, because a past deadline would fail it at once.
 *
 * "Follow the lineage of a task": each redrive records one `task_redrive` link, and
 * `Admin.getRedriveLineage` returns the chain from any task in it. Retention keeps an older task
 * while a newer task in its chain stays.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

function eventList(
  d: Diagram,
  events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[],
  lines: readonly string[],
  steps = events.length,
): number {
  const pitch = 56;
  events.forEach(([label, kind, name, sub], index) => {
    const top = 24 + index * pitch;
    // Only the first `steps` lines are a sequence; the lines after them are a list.
    if (index > 0 && index < steps) d.arrow(`M 248,${top - 14} V ${top - 2}`);
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

const copyTitle = "Redrive copies the work into a new task and keeps the failed task as evidence";
const copyDescription =
  "The operator redrives charge-4711 with the request ID r-77. Workhorse creates charge-9020, ready " +
  "on attempt 1, and records the link in the same transaction. charge-4711 stays failed, with its " +
  "error. The new task copies the queue, type, payload, tags, maximum attempts, retry policy, and " +
  "execution timeout. It does not copy checkpoints, waits, the attempt count, the cancellation " +
  "state, the old error, or the deadline.";

const copied = [
  "queue · type · payload",
  "tags",
  "maximum attempts",
  "retry policy",
  "execution timeout",
];
const notCopied = [
  "checkpoints · waits",
  "attempt count",
  "cancellation state",
  "old error",
  "deadline",
];

/** The copy diagram: the failed task, the new task, and the fields that the redrive copies. */
export const redriveCopy = {
  slug: "redrive-copy",
  title: copyTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.arrow("M 344,84 H 594");
    d.label(469, 64, "REDRIVE · r-77");
    d.box(24, 56, 320, 56, "store", "charge-4711", "failed · stays as evidence", 11);
    d.box(596, 56, 340, 56, "focal", "charge-9020", "ready · attempt 1 · no deadline", 11);

    const list = (x: number, heading: string, items: readonly string[], kind: Kind): void => {
      d.rows(x, 148, [[heading, 11, "ink", SANS, 600]], "start");
      items.forEach((item, index) => {
        d.box(x, 160 + index * 36, 440, 30, kind, item, undefined, 10);
      });
    };
    list(24, "copied: the work", copied, "backend");
    list(496, "not copied: the failed run", notCopied, "external");

    d.rows(
      24,
      372,
      [
        [
          "Redrive does not restart the failed task. A past deadline would fail the new task at once.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 388, copyTitle, copyDescription);
  },
};

/** The copy diagram for screens up to 600 px wide. */
export const redriveCopyNarrow = {
  slug: "redrive-copy-narrow",
  title: copyTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["failed", "store", "charge-4711", "stays as evidence"],
        ["new", "focal", "charge-9020", "ready · attempt 1 · no deadline"],
        ["copied", "backend", "the work", "queue, type, payload, tags, retry"],
        ["not", "external", "the failed run", "checkpoints, waits, error, deadline"],
      ],
      ["Redrive does not restart the failed", "task. It keeps it as evidence."],
      2,
    );
    return d.render(this.slug, 400, height, copyTitle, copyDescription);
  },
};

const lineageTitle = "Each redrive adds a link, so the lineage leads back to the first failure";
const lineageDescription =
  "charge-4711 failed, and a redrive created charge-9020. charge-9020 failed too, and a second " +
  "redrive created charge-9311. Each link is a task_redrive row. From any task in the chain, " +
  "Admin.getRedriveLineage returns the chain from the first failure to the newest redrive.";

const chain: readonly (readonly [kind: Kind, name: string, sub: string])[] = [
  ["store", "charge-4711", "failed · the first failure"],
  ["store", "charge-9020", "failed · redrive 1"],
  ["focal", "charge-9311", "ready · redrive 2"],
];

/** The lineage diagram: three tasks, linked by two redrives. */
export const redriveLineage = {
  slug: "redrive-lineage",
  title: lineageTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const width = 248;
    const x = (index: number): number => 24 + index * (width + 84);
    for (let index = 0; index < chain.length - 1; index += 1) {
      d.arrow(`M ${x(index) + width},92 H ${x(index + 1) - 2}`);
      d.label(x(index) + width + 42, 72, "task_redrive");
    }
    chain.forEach(([kind, name, sub], index) => {
      d.box(x(index), 64, width, 56, kind, name, sub, 11);
    });
    d.box(
      24,
      152,
      912,
      44,
      "backend",
      "Admin.getRedriveLineage(any task in the chain)",
      "returns the chain from the first failure to the newest redrive",
      11,
    );
    d.rows(
      24,
      228,
      [
        [
          "Retention keeps charge-4711 while a newer task in its chain stays.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 244, lineageTitle, lineageDescription);
  },
};

/** The lineage diagram for screens up to 600 px wide: one task on each line. */
export const redriveLineageNarrow = {
  slug: "redrive-lineage-narrow",
  title: lineageTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["first", "store", "charge-4711", "failed"],
        ["redrive", "store", "charge-9020", "failed too"],
        ["redrive", "focal", "charge-9311", "ready"],
      ],
      ["Each link is a task_redrive row.", "getRedriveLineage returns the chain."],
    );
    return d.render(this.slug, 400, height, lineageTitle, lineageDescription);
  },
};
