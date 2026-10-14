import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `docs/guides/180-agentic-flow.md`. It uses the names of that guide.
 *
 * "Plan one time and run the tools as child tasks" and "Wait for a timer and an approval": the
 * `agent.loop` handler for `conv-12` runs four times. Each row is one run, and each column is one
 * step of the handler code on the page. Run 1 calls the model in the `plan` checkpoint and creates
 * the `research` and `calculate` child tasks. Each later run starts at the first line and gets the
 * stored result of each earlier step: the checkpoint returns the stored plan, `runChildrenAll`
 * returns the stored tool results, and a relative timer keeps the wake time of its first call.
 * Thus, the model makes the plan one time, and each tool runs one time.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";
type Cell = readonly [kind: Kind, name: string, sub: string] | undefined;

const title = "The agent loop runs four times, but the model plans one time";
const description =
  "The agent.loop handler for conv-12 runs four times. Run 1 on worker A calls the model in the " +
  "plan checkpoint and creates the research and calculate child tasks. Run 2 on worker B gets the " +
  "stored plan and the stored tool results, and starts the model-cooldown timer. Run 3 gets past " +
  "the timer and waits for the approval signal. Run 4 gets the approval and completes the answer.";

const steps = [
  'checkpoint("plan")',
  "runChildrenAll",
  'sleep("model-cooldown")',
  'waitForSignal("approval")',
  "complete",
] as const;

const LEFT = 200;
const RIGHT = 936;
const GAP = 12;
const pitch = (RIGHT - LEFT + GAP) / steps.length;
const width = pitch - GAP;
const x = (index: number): number => LEFT + index * pitch;

const runs: readonly (readonly [label: readonly [string, string], cells: readonly Cell[]])[] = [
  [
    ["Run 1", "worker A"],
    [
      ["focal", "calls the model", "stores the plan"],
      ["backend", "creates 2 child tasks", "waits · frees slot"],
      undefined,
      undefined,
      undefined,
    ],
  ],
  [
    ["Run 2", "after the tools"],
    [
      ["store", "stored plan", "no model call"],
      ["store", "stored results", "no tool runs"],
      ["backend", "starts timer", "waits"],
      undefined,
      undefined,
    ],
  ],
  [
    ["Run 3", "after the cooldown"],
    [
      ["store", "stored plan", "no model call"],
      ["store", "stored results", "no tool runs"],
      ["store", "timer done", "returns"],
      ["backend", "waits", "for approval"],
      undefined,
    ],
  ],
  [
    ["Run 4", "after sendSignal"],
    [
      ["store", "stored plan", "no model call"],
      ["store", "stored results", "no tool runs"],
      ["store", "timer done", "returns"],
      ["store", "returns", "the approval"],
      ["backend", "completes", "the answer"],
    ],
  ],
];

/** The replay diagram: one row for each run of the handler, one column for each step. */
export const agentLoop = {
  slug: "agentic-flow-loop",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(
      24,
      40,
      [
        ["agent.loop", 12, "ink", SANS, 600],
        ["conv-12", 9, "muted", MONO, 400],
      ],
      "start",
    );
    steps.forEach((step, index) => {
      d.rows(x(index) + width / 2, 44, [[step, 8, "soft", MONO, 400]]);
    });
    d.divider(LEFT, RIGHT, 52);

    runs.forEach(([label, cells], row) => {
      const y = 72 + row * 56;
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
        if (cell === undefined) {
          d.rows(x(index) + width / 2, y + 24, [["not reached", 8, "soft", MONO, 400]]);
          return;
        }
        d.box(x(index), y, width, 40, cell[0], cell[1], cell[2], 10);
      });
    });

    const footerY = 72 + runs.length * 56 + 24;
    d.rows(
      24,
      footerY,
      [
        [
          "Each run starts at the first line and gets each stored step. The model and each tool run one time.",
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
  ["Run 1", "focal", "plan: calls the model", "then creates research, calculate"],
  ["Run 2", "store", "stored plan, stored results", "starts the cooldown timer"],
  ["Run 3", "store", "every step so far is stored", "waits for the approval"],
  ["Run 4", "backend", "returns the approval", "completes the answer"],
];

/** The replay diagram for screens up to 600 px wide: one run on each line. */
export const agentLoopNarrow = {
  slug: "agentic-flow-loop-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const rowPitch = 56;
    events.forEach(([label, kind, name, sub], index) => {
      const top = 24 + index * rowPitch;
      if (index > 0) d.arrow(`M 248,${top - 14} V ${top - 2}`);
      d.text(24, top + 25, label, { color: "ink" });
      d.box(112, top, 264, 42, kind, name, sub, 11);
    });
    const footerY = 24 + events.length * rowPitch + 8;
    d.rows(
      24,
      footerY,
      [
        ["Each run starts at the first line. The", 9, "muted", MONO, 400],
        ["model and each tool run one time.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
