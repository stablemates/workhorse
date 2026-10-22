import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The handler changes diagram: a stored checkpoint name with a changed operation. It shows one row
 * of the replay table of `docs/guides/132-handler-changes.md` and uses the names of that guide.
 *
 * The facts:
 *
 * - `HandlerContext.checkpoint(name, operation)` reads an existing value before it runs user code
 *   (guide 132, "Reference: what a replay compares").
 * - A stored checkpoint name with a new operation returns the stored value, and the operation does
 *   not run (the same table).
 * - The primary key `(task_id, checkpoint_name)` makes each name immutable for the task (the same
 *   reference block).
 *
 * The highlight marks the result, because the result is what a reader does not expect.
 *
 * Check each fact against its source before you change a label.
 */

const title = "A changed operation under a stored name does not run";
const description =
  "The old code stores a result under ship. After the task waits, the new code calls the same " +
  "checkpoint with a changed operation. Workhorse returns the stored result by name and does not " +
  "run the new operation.";
const footnote = "A changed operation does not replace the value of a stored name.";

export const handlerChangesSameName = {
  slug: "handler-changes-same-name",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.arrow("M 294,140 H 328");
    d.arrow("M 666,140 H 632");
    d.rows(
      24,
      44,
      [
        ["old code", 12, "ink", SANS, 600],
        ["before the wait", 9, "muted", MONO, 400],
      ],
      "start",
    );
    d.rows(
      666,
      44,
      [
        ["new code", 12, "ink", SANS, 600],
        ["after the wait", 9, "muted", MONO, 400],
      ],
      "start",
    );
    d.divider(24, 936, 68);
    d.box(24, 104, 270, 72, "backend", 'checkpoint("ship", old)', "stores its result", 11);
    d.box(336, 92, 288, 148, "store");
    d.rows(480, 120, [
      ["one stored row", 12, "ink", SANS, 600],
      ["the name is the key", 9, "muted", MONO, 400],
    ]);
    // The arrow starts on the ship row, so draw it after the frame and before the row.
    d.arrow("M 600,174 H 645 V 228 H 658");
    d.box(360, 148, 240, 52, "store", "ship", "result from old code", 11);
    d.box(666, 104, 270, 72, "backend", 'checkpoint("ship", new)', "same name", 11);
    d.box(
      666,
      202,
      270,
      52,
      "focal",
      "returns the stored result",
      "new operation does not run",
      11,
    );
    d.rows(24, 286, [[footnote, 9, "muted", MONO, 400]], "start");
    return d.render(this.slug, 960, 310, title, description);
  },
};

export const handlerChangesSameNameNarrow = {
  slug: "handler-changes-same-name-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(
      24,
      28,
      [
        ["old code", 12, "ink", SANS, 600],
        ["before the wait", 9, "muted", MONO, 400],
      ],
      "start",
    );
    d.box(24, 64, 328, 48, "backend", 'checkpoint("ship", old)', "stores its result", 11);
    d.arrow("M 188,112 V 132");
    d.box(24, 140, 328, 96, "store");
    d.rows(188, 164, [
      ["one stored row", 12, "ink", SANS, 600],
      ["the name is the key", 9, "muted", MONO, 400],
    ]);
    // The arrow starts on the ship row, so draw it after the frame and before the row.
    d.arrow("M 328,208 H 372 V 432 H 360");
    d.box(48, 188, 280, 40, "store", "ship", "result from old code", 11);
    d.arrow("M 188,236 V 256");
    d.rows(
      24,
      288,
      [
        ["new code", 12, "ink", SANS, 600],
        ["after the wait", 9, "muted", MONO, 400],
      ],
      "start",
    );
    d.box(24, 324, 328, 48, "backend", 'checkpoint("ship", new)', "same name", 11);
    d.arrow("M 188,372 V 392");
    d.box(24, 400, 328, 64, "focal", "returns the stored result", "new operation does not run", 11);
    d.rows(
      24,
      510,
      [
        ["A changed operation does not replace", 9, "muted", MONO, 400],
        ["the value of a stored name.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, 550, title, description);
  },
};
