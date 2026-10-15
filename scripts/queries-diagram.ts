import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `site/content/docs/queries.mdx`. It uses the names of that page.
 *
 * Each operator question has one read. `admin.getTask` returns a `TaskSnapshot`, or `null` if the
 * ID is unknown or the task was deleted. `admin.listTasks` returns pages, newest first, with a
 * cursor, and omits payloads by default. `admin.getTaskTimeline` merges events and closed attempts,
 * newest first, and can be empty after retention deletes the history. `queue.health()` reads the
 * values in one SQL statement and gives the level `healthy`, `degraded`, or `critical`.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const title = "One read for each operator question";
const description =
  "admin.getTask tells if a task exists and returns its TaskSnapshot, or null. admin.listTasks " +
  "returns pages of tasks, newest first, with a cursor and without payloads by default. " +
  "admin.getTaskTimeline merges events and closed attempts, and it can be empty after retention. " +
  "queue.health() reads the queue in one SQL statement and gives healthy, degraded, or critical.";

const rows: readonly (readonly [
  question: readonly [string, string],
  read: readonly [Kind, string, string],
  result: readonly [Kind, string, string],
])[] = [
  [
    ["Does it exist?", "one task"],
    ["focal", "admin.getTask(taskId)", "the current state"],
    ["store", "TaskSnapshot or null", "null if unknown or deleted"],
  ],
  [
    ["Which tasks?", "queue, type, states, time"],
    ["backend", "admin.listTasks(query)", "newest first"],
    ["store", "a page and nextCursor", "no payloads by default"],
  ],
  [
    ["What happened?", "the history"],
    ["backend", "admin.getTaskTimeline", "events + closed attempts"],
    ["external", "a page of entries", "can be empty after retention"],
  ],
  [
    ["Is it healthy?", "the queue"],
    ["backend", "queue.health()", "one SQL statement"],
    ["store", "healthy · degraded · critical", "with a code for each reason"],
  ],
];

const READ = 256;
const RESULT = 616;
const WIDTH = 320;

/** The query diagram: one row for each question, its read, and its result. */
export const queryReads = {
  slug: "query-reads",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    ["read", "result"].forEach((heading, index) => {
      d.rows([READ, RESULT][index]! + WIDTH / 2, 44, [[heading, 8, "soft", MONO, 400]]);
    });
    d.divider(READ, RESULT + WIDTH, 52);
    rows.forEach(([question, read, result], index) => {
      const y = 72 + index * 56;
      d.rows(
        24,
        y + 16,
        [
          [question[0], 11, "ink", SANS, 600],
          [question[1], 9, "muted", MONO, 400],
        ],
        "start",
      );
      d.arrow(`M ${READ + WIDTH},${y + 20} H ${RESULT - 2}`);
      d.box(READ, y, WIDTH, 40, read[0], read[1], read[2], 11);
      d.box(RESULT, y, WIDTH, 40, result[0], result[1], result[2], 11);
    });
    const footerY = 72 + rows.length * 56 + 24;
    d.rows(
      24,
      footerY,
      [
        [
          "An empty timeline does not prove that a task does not exist. Use getTask for that question.",
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
  ["exists?", "focal", "admin.getTask", "TaskSnapshot or null"],
  ["which?", "backend", "admin.listTasks", "pages · no payloads by default"],
  ["history", "backend", "admin.getTaskTimeline", "can be empty after retention"],
  ["health", "backend", "queue.health()", "healthy · degraded · critical"],
];

/** The query diagram for screens up to 600 px wide: one question on each line. */
export const queryReadsNarrow = {
  slug: "query-reads-narrow",
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
        ["An empty timeline does not prove that", 9, "muted", MONO, 400],
        ["a task does not exist.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
