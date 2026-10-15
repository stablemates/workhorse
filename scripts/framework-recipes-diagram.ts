import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `site/content/docs/langgraph.mdx` (with `python/examples/langgraph_approval.md`),
 * `site/content/docs/pydanticai.mdx`, `site/content/docs/active-job.mdx`, and
 * `site/content/docs/django-tasks.mdx`. Each diagram uses the names of its page.
 *
 * LangGraph: the owner table of "Give each owner its own state".
 *
 * PydanticAI: the first activation stores the history and the `agent-history-receipt` checkpoint,
 * then registers the `credit-approval` human wait. The reviewer approves. A new activation reads
 * the decision, and a new `Agent.run` call runs the `credit` tool.
 *
 * Active Job: a default job is an `active_job` task whose payload is the serialized job, and only the
 * Ruby worker runs it. A typed job names its own task type and takes one JSON `Hash`, so any
 * language worker can run it.
 *
 * Django Tasks: `greet.enqueue("Ada")` returns a `TaskResult` in an inner atomic block. A later
 * statement fails, Django rolls back the outer block, and PostgreSQL removes the task.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

function eventList(
  d: Diagram,
  events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[],
  lines: readonly string[],
  arrows = true,
): number {
  const pitch = 56;
  events.forEach(([label, kind, name, sub], index) => {
    const top = 24 + index * pitch;
    if (arrows && index > 0) d.arrow(`M 248,${top - 14} V ${top - 2}`);
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

function footer(d: Diagram, y: number, line: string): void {
  d.rows(24, y, [[line, 9, "muted", MONO, 400]], "start");
}

const ownersTitle = "Workhorse, LangGraph, and your application each own their own state";
const ownersDescription =
  "Workhorse owns admission, leases, the retry policy, and the langgraph-approval human wait. " +
  "LangGraph PostgresSaver owns the graph state, replay, and the actual Interrupt.id. Your " +
  "application owns graph-driver coordination, receipt storage, reviewer authorization, and tool " +
  "idempotency. The thread ID workhorse:{task_id} does not change.";

const owners: readonly (readonly [
  label: string,
  kind: Kind,
  items: readonly (readonly [string, string | undefined])[],
])[] = [
  [
    "WORKHORSE",
    "store",
    [
      ["admission · leases", undefined],
      ["retry policy", undefined],
      ["langgraph-approval", "the human wait"],
    ],
  ],
  [
    "LANGGRAPH POSTGRESSAVER",
    "backend",
    [
      ["graph state", undefined],
      ["replay", undefined],
      ["Interrupt.id", "the actual one"],
    ],
  ],
  [
    "YOUR APPLICATION",
    "backend",
    [
      ["graph-driver coordination", undefined],
      ["receipt storage", undefined],
      ["reviewer authorization", undefined],
      ["tool idempotency", undefined],
    ],
  ],
];

/** The owner diagram: one zone for each owner, one box for each part of the state. */
export const langgraphOwners = {
  slug: "langgraph-owners",
  title: ownersTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    owners.forEach(([label, kind, items], col) => {
      const x = 24 + col * 312;
      d.zone(x, 48, 288, 232, label);
      items.forEach(([name, sub], row) => {
        d.box(x + 16, 76 + row * 48, 256, 40, kind, name, sub, 11);
      });
    });
    footer(
      d,
      312,
      "The thread ID workhorse:{task_id} does not change. Workhorse checkpoints hold bridge receipts, not a graph snapshot.",
    );
    return d.render(this.slug, 960, 328, ownersTitle, ownersDescription);
  },
};

/** The owner diagram for screens up to 600 px wide: one owner on each line. */
export const langgraphOwnersNarrow = {
  slug: "langgraph-owners-narrow",
  title: ownersTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["Workhorse", "store", "admission · leases · retries", "the langgraph-approval wait"],
        ["LangGraph", "backend", "graph state · replay", "the actual Interrupt.id"],
        ["your app", "backend", "graph-driver coordination", "receipts · reviewers · tools"],
      ],
      ["The thread ID workhorse:{task_id}", "does not change."],
      false,
    );
    return d.render(this.slug, 400, height, ownersTitle, ownersDescription);
  },
};

const approvalTitle = "No process waits for the reviewer: a new activation resumes the Agent";
const approvalDescription =
  "In the first activation, the handler stores the history and the agent-history-receipt " +
  "checkpoint, then registers the credit-approval human wait, and Workhorse suspends the task. " +
  "The reviewer approves, and Workhorse commits the decision. A new activation reads the decision " +
  "and gives the history to a new Agent.run call, which runs the credit tool.";

const STEP = 156;
const STEP_GAP = 32;
const stepX = (index: number): number => 24 + index * (STEP + STEP_GAP);

const approvalSteps: readonly (readonly [kind: Kind, name: string, sub: string])[] = [
  ["store", "store the history", "agent-history-receipt"],
  ["backend", "credit-approval", "the task suspends"],
  ["external", "reviewer approves", "Workhorse commits it"],
  ["store", "read the decision", "then store it"],
  ["focal", "new Agent.run", "runs the credit tool"],
];

/** The approval diagram: two activations with the reviewer between them. */
export const pydanticaiApproval = {
  slug: "pydanticai-approval",
  title: approvalTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = 80;
    d.zone(stepX(0) - 8, 48, stepX(1) + STEP - stepX(0) + 16, 108, "ACTIVATION 1");
    d.zone(stepX(2) - 8, 48, STEP + 16, 108, "REVIEWER");
    d.zone(stepX(3) - 8, 48, stepX(4) + STEP - stepX(3) + 16, 108, "ACTIVATION 2");
    approvalSteps.forEach(([kind, name, sub], index) => {
      if (index > 0) d.arrow(`M ${stepX(index - 1) + STEP},${y + 26} H ${stepX(index) - 2}`);
      d.box(stepX(index), y, STEP, 52, kind, name, sub, 11);
    });
    footer(d, 188, "The conversation ID stays the task ID. Each Agent.run call gets a new run ID.");
    return d.render(this.slug, 960, 204, approvalTitle, approvalDescription);
  },
};

/** The approval diagram for screens up to 600 px wide: one step on each line. */
export const pydanticaiApprovalNarrow = {
  slug: "pydanticai-approval-narrow",
  title: approvalTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["first", "store", "store the history", "agent-history-receipt"],
        ["first", "backend", "credit-approval wait", "the task suspends"],
        ["review", "external", "reviewer approves", "Workhorse commits it"],
        ["second", "store", "read the decision", "then store it"],
        ["second", "focal", "new Agent.run", "runs the credit tool"],
      ],
      ["No live process waits for the reviewer."],
    );
    return d.render(this.slug, 400, height, approvalTitle, approvalDescription);
  },
};

const kindsTitle = "A default job runs only on Ruby; a typed job runs on any worker";
const kindsDescription =
  "A default job has no task type. Workhorse stores it as an active_job task whose payload is the " +
  "serialized job, and only the Ruby worker runs it. A typed job names its own task type with " +
  "workhorse_options and takes one JSON Hash with String keys. A Python, Go, TypeScript, Rust, or " +
  "Ruby worker can run it.";

const kinds: readonly (readonly [
  label: readonly [string, string],
  task: readonly [Kind, string, string],
  worker: readonly [Kind, string, string],
])[] = [
  [
    ["default job", "no task type"],
    ["store", "task type active_job", "payload: the serialized job"],
    ["backend", "the Ruby worker only", "every Active Job argument type"],
  ],
  [
    ["typed job", "workhorse_options task_type:"],
    ["store", "its own task type", "payload: one JSON Hash"],
    ["focal", "any language worker", "Python · Go · TypeScript · Rust · Ruby"],
  ],
];

/** The job kind diagram: one row for each kind, its task, and the workers that can run it. */
export const activeJobKinds = {
  slug: "active-job-kinds",
  title: kindsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const cols = [256, 616] as const;
    const width = 320;
    ["task", "who can run it"].forEach((heading, index) => {
      d.rows(cols[index]! + width / 2, 44, [[heading, 8, "soft", MONO, 400]]);
    });
    d.divider(cols[0], cols[1] + width, 52);
    kinds.forEach(([label, task, worker], index) => {
      const y = 72 + index * 64;
      d.rows(
        24,
        y + 18,
        [
          [label[0], 11, "ink", SANS, 600],
          [label[1], 9, "muted", MONO, 400],
        ],
        "start",
      );
      d.arrow(`M ${cols[0] + width},${y + 24} H ${cols[1] - 2}`);
      d.box(cols[0], y, width, 48, task[0], task[1], task[2], 11);
      d.box(cols[1], y, width, 48, worker[0], worker[1], worker[2], 11);
    });
    footer(
      d,
      220,
      "A typed job takes exactly one Hash with String keys. Its callers do not change.",
    );
    return d.render(this.slug, 960, 236, kindsTitle, kindsDescription);
  },
};

/** The job kind diagram for screens up to 600 px wide: one kind on each line. */
export const activeJobKindsNarrow = {
  slug: "active-job-kinds-narrow",
  title: kindsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["default", "store", "task type active_job", "the serialized job"],
        ["", "backend", "the Ruby worker only", "every argument type"],
        ["typed", "store", "its own task type", "one JSON Hash"],
        ["", "focal", "any language worker", "Python, Go, TS, Rust, Ruby"],
      ],
      ["A typed job takes exactly one Hash", "with String keys."],
      false,
    );
    return d.render(this.slug, 400, height, kindsTitle, kindsDescription);
  },
};

const acceptanceTitle = "A TaskResult shows acceptance; the outer block decides the commit";
const acceptanceDescription =
  'The request opens transaction.atomic(using="business"). In an inner atomic block, ' +
  'greet.enqueue("Ada") returns a TaskResult with the status READY and a task ID. A later ' +
  "statement in the outer block fails, and Django rolls back the outer block. PostgreSQL removes " +
  "the task, and the task ID identifies no task.";

/** The acceptance diagram: the enqueue in the inner block, the failure in the outer block. */
export const djangoTasksAcceptance = {
  slug: "django-tasks-acceptance",
  title: acceptanceTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.zone(24, 48, 640, 156, 'OUTER BLOCK · atomic(using="business")');
    d.zone(40, 80, 300, 108, "INNER ATOMIC BLOCK");
    d.arrow("M 324,134 H 366");
    d.arrow("M 648,134 H 702");
    d.box(56, 108, 268, 52, "focal", 'greet.enqueue("Ada")', "TaskResult · READY · task ID", 11);
    d.box(
      368,
      108,
      280,
      52,
      "external",
      "a later statement fails",
      "Django rolls back the outer block",
      11,
    );
    d.box(704, 108, 232, 52, "store", "the task is gone", "its task ID identifies no task", 11);
    footer(
      d,
      236,
      "A TaskResult shows that Workhorse accepted the task. It does not show that the transaction committed.",
    );
    return d.render(this.slug, 960, 252, acceptanceTitle, acceptanceDescription);
  },
};

/** The acceptance diagram for screens up to 600 px wide: one step on each line. */
export const djangoTasksAcceptanceNarrow = {
  slug: "django-tasks-acceptance-narrow",
  title: acceptanceTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["inner", "focal", 'greet.enqueue("Ada")', "TaskResult · READY · task ID"],
        ["outer", "external", "a later statement fails", "Django rolls back the outer block"],
        ["after", "store", "the task is gone", "its task ID identifies no task"],
      ],
      ["A TaskResult shows acceptance,", "not a commit."],
    );
    return d.render(this.slug, 400, height, acceptanceTitle, acceptanceDescription);
  },
};
