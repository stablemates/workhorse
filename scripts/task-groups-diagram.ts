import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/175-task-groups.md`. They use the names of that guide.
 *
 * "Create a group and run a callback when it finishes": `Queue.taskGroup` creates the group,
 * enqueues the member tasks, and seals the group in one transaction. A member task counts when it
 * becomes terminal. The transaction of the last terminal member task finishes the sealed group and
 * enqueues its callbacks. The result is `failed` because two member tasks failed, so `onSuccess`
 * does not run; the example defines only `onFinish`.
 *
 * "Add tasks over several transactions" and "Add tasks from a running member task": the group
 * state is `open`, `sealed`, or `finished`. `Queue.addToTaskGroup` raises an error after the seal.
 * A running member task can add with `ctx.taskGroup.add` also after the seal. An open group cannot
 * finish, and it never expires.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const finishTitle = "The last finished member task finishes the group and enqueues its callback";
const finishDescription =
  "Queue.taskGroup creates the group for imp-7, enqueues 20,000 imports.row tasks, and seals the " +
  "group in one transaction. Workers run the rows. 19,998 succeed, and 2 fail after their last " +
  "retry. In the transaction of the last terminal row, Workhorse finishes the group with the " +
  "result failed and enqueues the imports.report callback.";

/** The finish diagram: the group call, the member outcomes, the finished group, and the callback. */
export const groupFinish = {
  slug: "task-groups-finish",
  title: finishTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const top = 56;

    d.arrow(`M 216,${top + 72} H 254`);
    d.arrow(`M 476,${top + 72} H 514`);
    d.arrow(`M 716,${top + 72} H 754`);

    d.box(24, top + 40, 192, 64, "store", "Queue.taskGroup", "create · add 20,000 · seal", 11);
    d.rows(120, top + 128, [["one transaction", 8, "soft", MONO, 400]]);

    d.zone(256, top, 220, 152, "MEMBER TASKS · imports.row");
    d.box(272, top + 20, 188, 36, "backend", "19,998 succeeded", undefined, 11);
    d.box(272, top + 64, 188, 36, "backend", "2 failed", "after the last retry", 11);
    d.box(272, top + 108, 188, 32, "external", "pending: 0", undefined, 11);

    d.box(516, top + 40, 200, 64, "focal", "group finished", "result: failed", 11);
    d.rows(616, top + 128, [["in the transaction of the last row", 8, "soft", MONO, 400]]);

    d.box(756, top + 20, 180, 48, "backend", "onFinish", "imports.report enqueued", 11);
    d.box(756, top + 80, 180, 48, "external", "onSuccess", "only for succeeded", 11);

    d.rows(
      24,
      top + 192,
      [
        [
          "Each member task counts when it becomes terminal. A retry does not finish a member task.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, top + 208, finishTitle, finishDescription);
  },
};

function eventList(
  d: Diagram,
  events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[],
  lines: readonly string[],
): number {
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
    lines.map((line) => [line, 9, "muted", MONO, 400] as const),
    "start",
  );
  return footerY + 17 + lines.length * 15;
}

/** The finish diagram for screens up to 600 px wide: one event on each line. */
export const groupFinishNarrow = {
  slug: "task-groups-finish-narrow",
  title: finishTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["", "store", "Queue.taskGroup", "create · add 20,000 · seal"],
        ["", "backend", "19,998 rows succeed", "2 rows fail after the last retry"],
        ["", "focal", "group finished", "result: failed · pending: 0"],
        ["", "backend", "onFinish", "imports.report enqueued"],
      ],
      ["Each member task counts when it becomes", "terminal. A retry does not finish it."],
    );
    return d.render(this.slug, 400, height, finishTitle, finishDescription);
  },
};

const statesTitle =
  "An open group cannot finish. After the seal, only a running member task can add";
const statesDescription =
  "Queue.createTaskGroup creates an open group for imp-7. While it is open, the app adds pages of " +
  "rows with Queue.addToTaskGroup, and a running member task can add with ctx.taskGroup.add. " +
  "Queue.sealTaskGroup seals the group. After the seal, only a running member task can add. When " +
  "the last member task is finished, Workhorse finishes the group and enqueues the callbacks.";

const stateX = [192, 448, 704] as const;
const STATE_WIDTH = 232;

/** The state diagram: one column for each group state, with the calls that can add in it. */
export const groupStates = {
  slug: "task-groups-states",
  title: statesTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = 52;

    d.arrow(`M ${stateX[0] + STATE_WIDTH},${y + 24} H ${stateX[1] - 2}`);
    d.arrow(`M ${stateX[1] + STATE_WIDTH},${y + 24} H ${stateX[2] - 2}`);

    d.box(stateX[0], y, STATE_WIDTH, 48, "store", "open", "Queue.createTaskGroup", 11);
    d.box(stateX[1], y, STATE_WIDTH, 48, "store", "sealed", "Queue.sealTaskGroup", 11);
    d.box(stateX[2], y, STATE_WIDTH, 48, "focal", "finished", "the last member is finished", 11);

    d.text(24, y + 104, "the app adds", { size: 10, color: "ink" });
    d.rows(24, y + 120, [["Queue.addToTaskGroup", 8, "soft", MONO, 400]], "start");
    d.text(24, y + 168, "a member adds", { size: 10, color: "ink" });
    d.rows(24, y + 184, [["ctx.taskGroup.add", 8, "soft", MONO, 400]], "start");
    d.text(24, y + 232, "the group", { size: 10, color: "ink" });

    const cells: readonly (readonly [Kind, string, string])[][] = [
      [
        ["backend", "can add", "in the app's transaction"],
        ["external", "raises an error", "after the seal"],
        ["external", "raises an error", "the group is finished"],
      ],
      [
        ["backend", "can add", "while the member runs"],
        ["backend", "can add", "while the member runs"],
        ["external", "no add", "no member task runs"],
      ],
      [
        ["external", "cannot finish", "it never expires"],
        ["external", "waits", "for each pending member"],
        ["backend", "callbacks enqueued", "one time"],
      ],
    ];
    cells.forEach((row, rowIndex) => {
      row.forEach(([kind, name, sub], index) => {
        d.box(stateX[index]!, y + 84 + rowIndex * 64, STATE_WIDTH, 44, kind, name, sub, 11);
      });
    });

    d.rows(
      24,
      y + 300,
      [["If the app does not seal the group, the callbacks never run.", 9, "muted", MONO, 400]],
      "start",
    );
    return d.render(this.slug, 960, y + 316, statesTitle, statesDescription);
  },
};

/** The state diagram for screens up to 600 px wide: one state on each line. */
export const groupStatesNarrow = {
  slug: "task-groups-states-narrow",
  title: statesTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["open", "store", "Queue.createTaskGroup", "the app and members can add"],
        ["sealed", "store", "Queue.sealTaskGroup", "only a running member can add"],
        ["finished", "focal", "the last member is finished", "callbacks enqueued one time"],
      ],
      ["An open group cannot finish. If the app", "does not seal it, the callbacks never run."],
    );
    return d.render(this.slug, 400, height, statesTitle, statesDescription);
  },
};
