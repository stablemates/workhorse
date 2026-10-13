import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The durable waits diagram: one handler, one wait, two runs. It shows the scenario of
 * `docs/guides/130-durable-waits.md` and uses its names.
 *
 * Each row is one run of the handler. Each column is one line of the handler. The facts:
 *
 * - After a wait, Workhorse calls the handler again from its first line (guide 130).
 * - A checkpoint that finished returns its stored result, so its work does not run again
 *   (`docs/guides/030-delivery-guarantees.md`).
 * - A wait that ended returns at once (guide 130, `schedule_wait_v1`).
 * - During the wait, no worker holds the task. The task row is `scheduled`, it has no owner, and
 *   the worker's slot is free (guide 130).
 * - A wait uses no attempt. The second claim gets a new fence token (guide 130, "Expect a wait to
 *   keep the attempt"). The fence numbers are an illustration.
 *
 * Check each fact against its source before you change a label.
 */

const lines = [
  'ctx.checkpoint("welcome", …)',
  'ctx.sleepUntil("follow-up-window", …)',
  'ctx.checkpoint("follow-up", …)',
] as const;

type Cell = readonly [kind: "focal" | "backend" | "store", name: string, sub: string] | undefined;

const description =
  "Worker A runs the welcome checkpoint, then the handler sleeps until 16:00 and frees the worker. " +
  "No worker holds the task during the wait. At 16:00, worker B runs the handler from its first " +
  "line. The welcome checkpoint returns its stored result, the ended wait returns at once, and " +
  "the handler sends the follow-up. Both runs are attempt 1.";
const COLUMN_WIDTH = 240;
const columns = lines.map((_, index) => 192 + index * 252);
const ROW_HEIGHT = 48;

function run(
  d: Diagram,
  y: number,
  label: readonly [string, string, string],
  cells: readonly Cell[],
): void {
  d.rows(
    24,
    y + 14,
    [
      [label[0], 12, "ink", SANS, 600],
      [label[1], 9, "muted", MONO, 400],
      [label[2], 9, "muted", MONO, 400],
    ],
    "start",
  );
  cells.forEach((cell, index) => {
    const x = columns[index]!;
    if (cell === undefined) {
      d.rows(x + COLUMN_WIDTH / 2, y + ROW_HEIGHT / 2 + 3, [["not reached", 9, "soft", MONO, 400]]);
      return;
    }
    const [kind, name, sub] = cell;
    d.box(x, y, COLUMN_WIDTH, ROW_HEIGHT, kind, name, sub, 11);
  });
}

export const durableWaits = {
  slug: "durable-waits",
  title: "A durable wait frees the worker, and the handler runs again from its first line",
  render(theme: Theme): string {
    const d = new Diagram(theme);

    lines.forEach((line, index) => {
      d.rows(columns[index]! + COLUMN_WIDTH / 2, 52, [[line, 10, "ink", MONO, 400]]);
    });
    d.divider(192, 936, 68);

    run(
      d,
      84,
      ["Run 1", "worker A · 14:00", "attempt 1 · fence 1"],
      [
        ["backend", "runs", "sends the welcome · result stored"],
        ["focal", "pauses", "until 16:00 · frees the slot"],
        undefined,
      ],
    );

    d.box(192, 148, 744, 40, "external");
    d.rows(564, 172, [
      [
        "no worker holds the task · scheduled, no owner · a new deployment can replace worker A",
        9,
        "muted",
        MONO,
        400,
      ],
    ]);
    d.rows(
      24,
      164,
      [
        ["the wait", 9, "muted", MONO, 400],
        ["14:00 to 16:00", 9, "soft", MONO, 400],
      ],
      "start",
    );

    run(
      d,
      204,
      ["Run 2", "worker B · 16:00", "attempt 1 · fence 2"],
      [
        ["store", "replays", "stored result · no second email"],
        ["store", "returns", "the wait ended"],
        ["backend", "runs", "sends the follow-up · task succeeds"],
      ],
    );

    return d.render(this.slug, 960, 276, this.title, description);
  },
};

const narrowCells: readonly (readonly [string, Cell, Cell])[] = [
  [
    'checkpoint("welcome")',
    ["backend", "runs", "sends the welcome · result stored"],
    ["store", "replays", "stored result · no second email"],
  ],
  [
    'sleepUntil("follow-up-window")',
    ["focal", "pauses", "until 16:00 · frees the slot"],
    ["store", "returns", "the wait ended"],
  ],
  [
    'checkpoint("follow-up")',
    undefined,
    ["backend", "runs", "sends the follow-up · task succeeds"],
  ],
];

/**
 * The same diagram for screens up to 600 px wide. Each run is a block, and each handler line is
 * one row of that block, so a phone shows it at almost full size.
 */
export const durableWaitsNarrow = {
  slug: "durable-waits-narrow",
  title: durableWaits.title,
  render(theme: Theme): string {
    const d = new Diagram(theme);

    const block = (top: number, label: string, detail: string, column: 1 | 2): number => {
      d.rows(
        24,
        top,
        [
          [label, 12, "ink", SANS, 600],
          [detail, 9, "muted", MONO, 400],
        ],
        "start",
      );
      let y = top + 28;
      for (const row of narrowCells) {
        d.text(24, y + 10, row[0], { color: "soft" });
        const cell = row[column];
        if (cell === undefined) {
          d.rows(200, y + 38, [["not reached", 9, "soft", MONO, 400]]);
        } else {
          const [kind, name, sub] = cell;
          d.box(24, y + 16, 352, 44, kind, name, sub, 11);
        }
        y += 68;
      }
      return y;
    };

    const afterFirst = block(36, "Run 1", "worker A · 14:00 · attempt 1 · fence 1", 1);
    d.box(24, afterFirst + 4, 352, 52, "external");
    d.rows(200, afterFirst + 26, [
      ["the wait · 14:00 to 16:00", 9, "ink", MONO, 400],
      ["no worker holds the task · scheduled, no owner", 9, "muted", MONO, 400],
    ]);
    const end = block(afterFirst + 84, "Run 2", "worker B · 16:00 · attempt 1 · fence 2", 2);

    return d.render(this.slug, 400, end + 12, this.title, description);
  },
};
