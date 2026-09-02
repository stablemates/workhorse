/**
 * The agent documentation eval's task set, fixed by WH-524 and ADR 0049.
 *
 * Four tasks reuse the WH-518 baseline's task text verbatim, so a later run compares against
 * recorded sessions rather than against a fresh prompt. The start point is a task dimension and
 * never a scored one: tasks A and D differ only in it, and that pair measures what the agent entry
 * point costs.
 */

export const taskIds = ["A", "B", "C", "D"] as const;

export type TaskId = (typeof taskIds)[number];

export type Language = "typescript" | "python" | "go";

export interface Task {
  readonly id: TaskId;
  readonly language: Language;
  /** The one URL a session is given. Everything else must be reached by following a link. */
  readonly startUrl: string;
  /** How the start point reads in a report. */
  readonly startLabel: string;
}

/** The site an agent surface belongs to. A fetch anywhere else is off-site. */
export const documentationHost = "workhorse.run";

/**
 * The task text every session receives, verbatim from the WH-518 baseline. Changing it makes a run
 * incomparable with the recorded fixtures, which is the whole point of freezing it here.
 */
export const taskText = [
  "An existing application already uses PostgreSQL and inserts an order row.",
  "Add a background job that sends the confirmation email through an external HTTP provider,",
  "enqueued alongside the order write, plus the worker that handles it.",
].join(" ");

/** Fetches one session may spend. The baseline's four sessions used 15 to 18. */
export const fetchBudget = 20;

export const tasks: readonly Task[] = [
  {
    id: "A",
    language: "typescript",
    startUrl: `https://${documentationHost}`,
    startLabel: "the site landing page",
  },
  {
    id: "B",
    language: "python",
    startUrl: `https://${documentationHost}`,
    startLabel: "the site landing page",
  },
  {
    id: "C",
    language: "go",
    startUrl: `https://${documentationHost}`,
    startLabel: "the site landing page",
  },
  {
    id: "D",
    language: "typescript",
    startUrl: "https://raw.githubusercontent.com/stablemates/workhorse/main/README.md",
    startLabel: "the root README on GitHub",
  },
];

export function taskById(id: string): Task {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) {
    throw new Error(`Unknown eval task ${id}. Known tasks: ${taskIds.join(", ")}.`);
  }
  return task;
}
