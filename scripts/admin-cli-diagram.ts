import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/380-admin-cli-and-tui.md`. They use the names of that guide.
 *
 * "Find what a stopped task waits for": `admin checkpoints` and `admin waits` show the records of
 * one task, and `admin external-waits` lists every task that waits for a person or an external
 * system. Together they tell a running handler, a durable timer, and a pending decision apart.
 *
 * "Name the target database before a change": a guarded command checks the database name that
 * `--env` gives against the database that the client connected to. No flag stops this check. Then
 * it needs a confirmation: the typed identity in an interactive session, or `--yes` in a script.
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

const waitsTitle = "Three read-only commands tell why a task does not finish";
const waitsDescription =
  "The task order-88 did not finish in one hour. admin checkpoints order-88 shows that the handler " +
  "completed reserve-stock, so it ran. admin waits order-88 shows no durable timer. admin " +
  "external-waits lists order-88 with a pending human decision named approval.";

const commands: readonly (readonly [command: string, kind: Kind, name: string, sub: string])[] = [
  ["admin checkpoints order-88", "store", "reserve-stock completed", "the handler ran"],
  ["admin waits order-88", "external", "no durable timer", "the task does not sleep"],
  ["admin external-waits", "focal", "order-88: approval", "a pending human decision"],
];

/** The wait diagram: one row for each command, with what it found. */
export const adminWaits = {
  slug: "admin-cli-waits",
  title: waitsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(
      24,
      40,
      [
        ["order-88", 12, "ink", SANS, 600],
        ["did not finish in one hour", 9, "muted", MONO, 400],
      ],
      "start",
    );
    commands.forEach(([command, kind, name, sub], index) => {
      const y = 72 + index * 56;
      d.arrow(`M 444,${y + 20} H 534`);
      d.box(24, y, 420, 40, "backend", command, undefined, 11);
      d.box(536, y, 400, 40, kind, name, sub, 11);
    });
    d.rows(
      24,
      268,
      [
        [
          "These commands only read. You can run them on production without a confirmation.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 284, waitsTitle, waitsDescription);
  },
};

/** The wait diagram for screens up to 600 px wide: one command on each line. */
export const adminWaitsNarrow = {
  slug: "admin-cli-waits-narrow",
  title: waitsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["checkpoints", "store", "reserve-stock completed", "the handler ran"],
        ["waits", "external", "no durable timer", "the task does not sleep"],
        ["external", "focal", "order-88: approval", "a pending human decision"],
      ],
      ["These commands only read. They need no", "confirmation on production."],
    );
    return d.render(this.slug, 400, height, waitsTitle, waitsDescription);
  },
};

const guardTitle = "A guarded command checks the database name, then asks for a confirmation";
const guardDescription =
  "The engineer runs admin redrive with --env workhorse_production, but the shell still points to " +
  "staging. The client asks the database for its name and gets workhorse_staging. The names are " +
  "different, so the command changes nothing. After the engineer corrects the URL and adds --yes, " +
  "both checks pass, and the redrive occurs. No flag stops the database name check.";

/** The guard diagram: the two checks, with the refused run above and the accepted run below. */
export const adminGuard = {
  slug: "admin-cli-guard",
  title: guardTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const cols = [200, 448, 696] as const;
    const width = 232;
    ["1 · database name", "2 · confirmation", "result"].forEach((heading, index) => {
      d.rows(cols[index]! + width / 2, 44, [[heading, 8, "soft", MONO, 400]]);
    });
    d.divider(200, 936, 52);

    const run = (
      y: number,
      label: readonly [string, string],
      cells: readonly (readonly [Kind, string, string] | undefined)[],
    ): void => {
      d.rows(
        24,
        y + 16,
        [
          [label[0], 11, "ink", SANS, 600],
          [label[1], 9, "muted", MONO, 400],
        ],
        "start",
      );
      cells.forEach((cell, index) => {
        if (cell) d.box(cols[index]!, y, width, 40, cell[0], cell[1], cell[2], 11);
      });
    };

    run(
      72,
      ["first run", "the old staging URL"],
      [
        ["focal", "workhorse_staging", "--env names production"],
        undefined,
        ["external", "refused", "nothing changes"],
      ],
    );
    d.rows(cols[1]! + width / 2, 96, [["not reached", 8, "soft", MONO, 400]]);
    run(
      128,
      ["second run", "the corrected URL"],
      [
        ["store", "workhorse_production", "the names are the same"],
        ["store", "--yes", "the script confirms"],
        ["backend", "redrive occurs", "with the reason and actor"],
      ],
    );

    d.rows(
      24,
      208,
      [
        [
          "No flag stops the database name check. In an interactive session, you type the identity again.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 224, guardTitle, guardDescription);
  },
};

/** The guard diagram for screens up to 600 px wide: one step on each line. */
export const adminGuardNarrow = {
  slug: "admin-cli-guard-narrow",
  title: guardTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["run 1", "focal", "connected: workhorse_staging", "--env names production"],
        ["", "external", "refused", "nothing changes"],
        ["run 2", "store", "names match · --yes", "both checks pass"],
        ["", "backend", "redrive occurs", "with the reason and actor"],
      ],
      ["No flag stops the database name check."],
    );
    return d.render(this.slug, 400, height, guardTitle, guardDescription);
  },
};
