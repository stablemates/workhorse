import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/170-child-tasks.md`. They use the names of that guide.
 *
 * "Run one child task from a handler": worker A runs `orders.checkout` for `ord-9`, and
 * `ctx.runChild("charge", "payments.charge", …)` creates the child, links it, and moves the parent
 * to `blocked` in one transaction. A payments worker charges the card. The success of the child
 * releases the parent. Worker B runs the handler from the first line with a new fence token, and
 * the same request returns the stored receipt and creates no task. The wait does not use an
 * attempt of the parent. The layout is the layout of `signals-wait`.
 *
 * "Run several children at the same time" and "Require every child to succeed": `inventory`
 * succeeds at 2 s, and `fraud` fails at 5 s. Workhorse releases a `runChildren` parent only after
 * every child ends, and the handler gets one outcome for each name. A `runChildrenAll` parent
 * fails, and the handler does not run again.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";
type Cell = readonly [kind: Kind, name: string, sub: string] | undefined;

const joinColumns = [192, 572] as const;
const JOIN_WIDTH = 364;

function joinRun(
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
    const x = joinColumns[index]!;
    if (cell === undefined) {
      d.rows(x + JOIN_WIDTH / 2, y + 27, [["not reached", 9, "soft", MONO, 400]]);
      return;
    }
    d.box(x, y, JOIN_WIDTH, 48, cell[0], cell[1], cell[2], 11);
  });
}

const joinTitle = "A parent gives up its worker until its child succeeds";
const joinDescription =
  "Worker A runs orders.checkout for ord-9, and the handler calls runChild for the charge. " +
  "Workhorse creates the child and blocks the parent, and worker A has a free slot. A payments " +
  "worker charges the card, and the child succeeds with a receipt. The success releases the " +
  "parent. Worker B runs the handler from its first line, and runChild returns the stored receipt " +
  "and creates no task.";

/** The join diagram: each row is one run of the parent handler, and each column is one line. */
export const childJoin = {
  slug: "child-tasks-join",
  title: joinTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    ['ctx.runChild("charge", "payments.charge", …)', "return { receiptId }"].forEach(
      (line, index) => {
        d.rows(joinColumns[index]! + JOIN_WIDTH / 2, 52, [[line, 10, "ink", MONO, 400]]);
      },
    );
    d.divider(192, 936, 68);

    joinRun(
      d,
      84,
      ["Run 1", "worker A", "fence 1"],
      [["focal", "creates the child", "the parent is blocked · frees the slot"], undefined],
    );

    d.box(192, 148, 744, 40, "external");
    d.rows(564, 172, [
      ["no worker holds the parent · a payments worker charges the card", 9, "muted", MONO, 400],
    ]);
    d.rows(24, 172, [["the child runs", 9, "muted", MONO, 400]], "start");

    d.box(
      192,
      204,
      744,
      44,
      "store",
      "the charge child succeeds with a receipt",
      "Workhorse stores the receipt · the parent is released",
      11,
    );
    d.rows(24, 230, [["the child ends", 9, "muted", MONO, 400]], "start");

    joinRun(
      d,
      264,
      ["Run 2", "worker B", "fence 2"],
      [
        ["store", "returns", "the stored receipt · no new task"],
        ["backend", "runs", "the checkout finishes"],
      ],
    );

    d.rows(
      24,
      352,
      [
        [
          "Each run starts at the first line of the handler. The wait does not use an attempt.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 368, joinTitle, joinDescription);
  },
};

function eventList(
  d: Diagram,
  events: readonly (readonly [time: string, kind: Kind, name: string, sub: string])[],
  lines: readonly string[],
): number {
  const pitch = 56;
  events.forEach(([time, kind, name, sub], index) => {
    const top = 24 + index * pitch;
    // "or" starts an alternative to the event above it, not a later event.
    if (index > 0 && time !== "or") d.arrow(`M 248,${top - 14} V ${top - 2}`);
    if (time) d.text(24, top + 25, time, { color: "ink" });
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

/** The join diagram for screens up to 600 px wide: one event on each line. */
export const childJoinNarrow = {
  slug: "child-tasks-join-narrow",
  title: joinTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["Run 1", "focal", "worker A: runChild", "the parent is blocked · free slot"],
        ["child", "external", "a payments worker", "charges the card"],
        ["", "store", "the child succeeds", "the parent is released"],
        ["Run 2", "store", "worker B: runChild", "the stored receipt · no new task"],
        ["", "backend", "the checkout finishes", "returns the receipt ID"],
      ],
      ["Each run starts at the first line of the", "handler. The wait does not use an attempt."],
    );
    return d.render(this.slug, 400, height, joinTitle, joinDescription);
  },
};

const modesTitle = "The join mode decides what a failed child does to the parent";
const modesDescription =
  "The checkout handler for ord-9 starts the fraud and inventory children. At 2 s, inventory " +
  "succeeds. At 5 s, fraud fails. With runChildren, Workhorse releases the parent, and the handler " +
  "runs again and gets a failed outcome for fraud. With runChildrenAll, Workhorse fails the " +
  "parent, and the handler does not run again.";

const col = (index: number): number => 200 + index * 188;
const colWidth = 172;

/** The mode diagram: two children, then one row for each join mode of the parent. */
export const childModes = {
  slug: "child-tasks-modes",
  title: modesTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(
      24,
      40,
      [
        ["orders.checkout", 12, "ink", SANS, 600],
        ["ord-9 · 2 children", 9, "muted", MONO, 400],
      ],
      "start",
    );
    ["the set starts", "2 s", "5 s", "then"].forEach((time, index) => {
      d.rows(col(index) + colWidth / 2, 44, [[time, 8, "soft", MONO, 400]]);
    });
    d.divider(col(0), col(3) + colWidth, 52);

    const rows: readonly (readonly [name: string, cells: readonly Cell[]])[] = [
      [
        "inventory",
        [
          ["external", "runs", "a child task"],
          ["backend", "succeeds", "reserved"],
          undefined,
          undefined,
        ],
      ],
      [
        "fraud",
        [
          ["external", "runs", "a child task"],
          ["external", "runs", "the set is not done"],
          ["backend", "fails", "every child has ended"],
          undefined,
        ],
      ],
      [
        "runChildren",
        [
          ["store", "blocked", "one time for the set"],
          ["store", "blocked", "fraud still runs"],
          ["store", "released", "a worker claims it"],
          ["focal", "handler runs again", "fraud: failed outcome"],
        ],
      ],
      [
        "runChildrenAll",
        [
          ["store", "blocked", "one time for the set"],
          ["store", "blocked", "fraud still runs"],
          ["focal", "failed", "a child failed"],
          ["external", "no second run", "the handler stops"],
        ],
      ],
    ];
    rows.forEach(([name, cells], row) => {
      const y = 72 + row * 56;
      d.text(24, y + 25, name, { size: 10, color: "ink" });
      cells.forEach((cell, index) => {
        if (cell) d.box(col(index), y, colWidth, 40, cell[0], cell[1], cell[2], 11);
      });
    });
    d.divider(24, col(3) + colWidth, 72 + 2 * 56 - 8);

    d.rows(
      24,
      72 + rows.length * 56 + 24,
      [
        [
          "runChildren returns each outcome to the handler. runChildrenAll fails the parent instead.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 72 + rows.length * 56 + 40, modesTitle, modesDescription);
  },
};

/** The mode diagram for screens up to 600 px wide: one event on each line. */
export const childModesNarrow = {
  slug: "child-tasks-modes-narrow",
  title: modesTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["2 s", "backend", "inventory succeeds", "the parent stays blocked"],
        ["5 s", "backend", "fraud fails", "every child has ended"],
        ["", "focal", "runChildren", "the handler gets a failed outcome"],
        ["or", "focal", "runChildrenAll", "the parent fails · no second run"],
      ],
      ["runChildren returns each outcome.", "runChildrenAll fails the parent instead."],
    );
    return d.render(this.slug, 400, height, modesTitle, modesDescription);
  },
};
