import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/240-concurrency-policies.md`. They use the names of that guide.
 *
 * "Limit the active tasks of a queue and of each key": the policy of `mail` allows twenty active
 * tasks and three for each `concurrencyKey`. A task without a key uses queue capacity but no key
 * capacity. PostgreSQL admits three `tenant-a` tasks, three `tenant-b` tasks, and the two tasks
 * without a key. The other tasks stay ready, although the queue has room and worker slots are free.
 *
 * "Share one budget across queues": the budget `vendor-api` allows four active tasks across
 * `billing` and `crm`. A task must obey the policy of its queue and its budget.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const TASK = 64;
const TASK_GAP = 8;
const taskX = (index: number): number => 200 + index * (TASK + TASK_GAP);

function eventList(
  d: Diagram,
  events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[],
  lines: readonly string[],
): number {
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
    lines.map((line) => [line, 9, "muted", MONO, 400] as const),
    "start",
  );
  return footerY + 17 + lines.length * 15;
}

const keysTitle = "A full key keeps its tasks ready, although the queue has room";
const keysDescription =
  "The policy of the queue mail allows twenty active tasks and three for each key. Six tenant-a " +
  "tasks, four tenant-b tasks, and two tasks without a key are ready. Workhorse admits three " +
  "tenant-a tasks, three tenant-b tasks, and the two tasks without a key. The queue has room for " +
  "twelve more, but each remaining task has a full key, so it stays ready.";

const keyRows: readonly (readonly [
  key: string,
  ready: string,
  active: number,
  waiting: number,
  status: readonly [Kind, string, string],
])[] = [
  ["tenant-a", "6 ready", 3, 3, ["focal", "key full · 3 of 3", "3 tasks stay ready"]],
  ["tenant-b", "4 ready", 3, 1, ["focal", "key full · 3 of 3", "1 task stays ready"]],
  ["no key", "2 ready", 2, 0, ["store", "no key limit", "uses queue capacity only"]],
];

/** The key diagram: one row for each key, one small box for each ready task. */
export const policyKeys = {
  slug: "concurrency-keys",
  title: keysTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(
      24,
      40,
      [
        ["mail", 12, "ink", SANS, 600],
        ["maxActive 20 · maxActivePerKey 3", 9, "muted", MONO, 400],
      ],
      "start",
    );
    keyRows.forEach(([key, ready, active, waiting, status], row) => {
      const y = 80 + row * 56;
      d.rows(
        24,
        y + 16,
        [
          [key, 11, "ink", SANS, 600],
          [ready, 9, "muted", MONO, 400],
        ],
        "start",
      );
      for (let index = 0; index < active + waiting; index += 1) {
        const admitted = index < active;
        d.box(
          taskX(index),
          y,
          TASK,
          40,
          admitted ? "backend" : "external",
          admitted ? "active" : "ready",
          undefined,
          10,
        );
      }
      d.box(680, y, 256, 40, status[0], status[1], status[2], 11);
    });
    const footerY = 80 + keyRows.length * 56 + 24;
    d.rows(
      24,
      footerY,
      [
        [
          "8 of 20 active. PostgreSQL decides each admission, so the limit holds for any number of workers.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, footerY + 16, keysTitle, keysDescription);
  },
};

/** The key diagram for screens up to 600 px wide: one key on each line. */
export const policyKeysNarrow = {
  slug: "concurrency-keys-narrow",
  title: keysTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["tenant-a", "focal", "3 active · key full", "3 tasks stay ready"],
        ["tenant-b", "focal", "3 active · key full", "1 task stays ready"],
        ["no key", "store", "2 active", "no key limit"],
        ["mail", "backend", "8 of 20 active", "the queue has room"],
      ],
      ["A task with a full key stays ready,", "although the queue has room."],
    );
    return d.render(this.slug, 400, height, keysTitle, keysDescription);
  },
};

const budgetTitle = "A budget limits the active tasks of several queues together";
const budgetDescription =
  "The queues billing and crm call one vendor API, and the budget vendor-api allows four active " +
  "tasks. At 1 s, billing runs three invoice.sync tasks. crm has two ready contact.sync tasks, and " +
  "its own policy has room. Workhorse admits one, because the budget has room for one. The other " +
  "task stays ready until an invoice.sync task completes at 3 s.";

/** The budget diagram: two queue zones and the budget that their tasks share. */
export const policyBudget = {
  slug: "concurrency-budget",
  title: budgetTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const budgetY = 108;

    d.arrow(`M 456,84 H 560 V ${budgetY + 14} H 598`);
    d.arrow(`M 456,180 H 560 V ${budgetY + 34} H 598`);

    d.zone(24, 48, 432, 72, "QUEUE · billing · at 1 s");
    for (let index = 0; index < 3; index += 1) {
      d.box(40 + index * 136, 64, 128, 40, "backend", "invoice.sync", "active", 11);
    }
    d.zone(24, 144, 432, 72, "QUEUE · crm · its policy has room");
    d.box(40, 160, 128, 40, "backend", "contact.sync", "active", 11);
    d.box(176, 160, 128, 40, "external", "contact.sync", "stays ready", 11);

    d.box(600, budgetY, 336, 48, "focal", "budget vendor-api", "4 of 4 active · no room", 11);
    d.rows(768, budgetY + 72, [["at 3 s, an invoice.sync completes", 8, "soft", MONO, 400]]);
    d.rows(768, budgetY + 86, [["and the waiting contact.sync starts", 8, "soft", MONO, 400]]);

    d.rows(
      24,
      256,
      [
        [
          "A task must obey the policy of its queue and the budget that it names.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 272, budgetTitle, budgetDescription);
  },
};

/** The budget diagram for screens up to 600 px wide: one event on each line. */
export const policyBudgetNarrow = {
  slug: "concurrency-budget-narrow",
  title: budgetTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["0 s", "backend", "billing: 3 invoice.sync", "3 of 4 in vendor-api"],
        ["1 s", "backend", "crm: 1 contact.sync starts", "4 of 4 in vendor-api"],
        ["1 s", "focal", "crm: 1 contact.sync waits", "the budget is full"],
        ["3 s", "backend", "an invoice.sync completes", "the waiting task starts"],
      ],
      ["A task must obey the policy of its queue", "and the budget that it names."],
    );
    return d.render(this.slug, 400, height, budgetTitle, budgetDescription);
  },
};
