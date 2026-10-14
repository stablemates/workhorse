import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `docs/guides/230-payload-contracts.md`. It uses the names of that guide.
 *
 * "Check the payload when you enqueue a task" and "Check the result when a task is complete":
 * Workhorse checks the payload of `mail.send` before it saves the task. A failed check raises
 * `TaskContractValidationError` in the enqueue code, and no task exists. A saved task keeps the
 * version that `currentVersion` named, here `mail-current`. Workhorse checks the result of the
 * handler with that version. A failed result check fails the attempt, and the retry rules apply.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const title =
  "Workhorse checks the payload before it saves a task, and the result before it completes it";
const description =
  "The app enqueues mail.send. Workhorse checks the payload with the payload contract. If the " +
  "check fails, the enqueue code gets TaskContractValidationError, and Workhorse saves no task. " +
  "Otherwise, Workhorse saves the task with the version mail-current. A worker runs the handler, " +
  "and Workhorse checks the result with mail-current. If the check fails, the attempt fails, and " +
  "the retry rules apply. Otherwise, the task is complete.";

const steps: readonly (readonly [kind: Kind, name: string, sub: string])[] = [
  ["external", "the app enqueues", "mail.send"],
  ["focal", "payload check", "mail-current"],
  ["store", "task saved", "keeps mail-current"],
  ["backend", "the handler runs", "returns a result"],
  ["focal", "result check", "mail-current"],
  ["backend", "task complete", "the result is stored"],
];

const BOX = 132;
const GAP = 24;
const x = (index: number): number => 24 + index * (BOX + GAP);

/** The check flow: six steps in one row, with the failure of each check below it. */
export const contractChecks = {
  slug: "contracts-checks",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = 56;
    for (let index = 0; index < steps.length - 1; index += 1) {
      d.arrow(`M ${x(index) + BOX},${y + 24} H ${x(index + 1) - 2}`);
    }
    for (const index of [1, 4]) {
      d.arrow(`M ${x(index) + BOX / 2},${y + 48} V ${y + 102}`, { dashed: true });
    }
    steps.forEach(([kind, name, sub], index) => {
      d.box(x(index), y, BOX, 48, kind, name, sub, 11);
    });
    d.label(x(1) + BOX / 2, y + 66, "FAILS");
    d.label(x(4) + BOX / 2, y + 66, "FAILS");

    d.box(
      x(0),
      y + 104,
      x(2) + BOX - x(0),
      48,
      "external",
      "TaskContractValidationError",
      "in the enqueue code · no task is saved",
      11,
    );
    d.box(
      x(3),
      y + 104,
      x(5) + BOX - x(3),
      48,
      "external",
      "the attempt fails",
      "the retry rules apply · the task is not complete",
      11,
    );

    d.rows(
      24,
      y + 192,
      [
        [
          "The error occurs in the code that enqueued the task, or in the attempt that returned the result.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, y + 208, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["app", "external", "the app enqueues mail.send", "Workhorse checks the payload"],
  ["fails", "external", "TaskContractValidationError", "no task is saved"],
  ["passes", "store", "task saved", "keeps mail-current"],
  ["worker", "backend", "the handler returns", "Workhorse checks the result"],
  ["fails", "external", "the attempt fails", "the retry rules apply"],
  ["passes", "backend", "task complete", "the result is stored"],
];

/** The check flow for screens up to 600 px wide: one step on each line. */
export const contractChecksNarrow = {
  slug: "contracts-checks-narrow",
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
        ["The error occurs in the enqueue code, or", 9, "muted", MONO, 400],
        ["in the attempt that returned the result.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
