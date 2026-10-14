import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/260-multi-tenancy.md`. They use the names of that guide.
 *
 * "Give each tenant a fair share of one database": in a shared database, the tenant is not a
 * column. The app writes the same identifier into `concurrencyKey`, `budget`, and a `tenant:` tag.
 * The concurrency policy of `reports` limits each key to 4 active tasks, the budget `acme` limits
 * the tenant to 8 active tasks across all queues, and the tag lets an operator filter task lists.
 * Workhorse does not check that the three agree.
 *
 * "Keep each tenant in its own database": each tenant has a database with the Workhorse schema
 * and its own worker fleet, so PostgreSQL enforces the boundary.
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

const optionsTitle = "One tenant identifier goes into three enqueue options";
const optionsDescription =
  "The app enqueues report.generate on the queue reports for the tenant acme. It writes acme into " +
  "concurrencyKey, budget, and a tenant:acme tag. The concurrency policy of reports lets acme run " +
  "4 tasks at the same time. The budget acme lets acme run 8 tasks across all queues. The tag lets " +
  "an operator filter the task list. Workhorse does not check that the three agree.";

const options: readonly (readonly [option: string, kind: Kind, name: string, sub: string])[] = [
  [
    "concurrencyKey: acme",
    "backend",
    "concurrency policy of reports",
    "4 active for acme · fair share",
  ],
  ["budget: acme", "backend", "budget acme", "8 active across all queues"],
  ["tags: tenant:acme", "backend", "tag filter", "the operator sees only acme"],
];

/** The option diagram: the task and its three options, each with what enforces it. */
export const tenantOptions = {
  slug: "multi-tenancy-options",
  title: optionsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    options.forEach((_, index) => {
      const y = 76 + index * 64;
      d.arrow(`M 420,${y + 22} H 536`);
    });
    d.zone(24, 56, 396, 204, "TASK · report.generate · queue reports");
    options.forEach(([option], index) => {
      d.box(40, 72 + index * 64, 364, 44, "store", option, undefined, 11);
    });
    options.forEach(([, kind, name, sub], index) => {
      d.box(538, 72 + index * 64, 398, 44, kind, name, sub, 11);
    });
    d.rows(
      24,
      292,
      [
        [
          "Your app keeps the three options consistent. Workhorse does not check that they agree.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 308, optionsTitle, optionsDescription);
  },
};

/** The option diagram for screens up to 600 px wide: one option on each line. */
export const tenantOptionsNarrow = {
  slug: "multi-tenancy-options-narrow",
  title: optionsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["key", "store", "concurrencyKey: acme", "4 active for acme in reports"],
        ["budget", "store", "budget: acme", "8 active across all queues"],
        ["tag", "backend", "tags: tenant:acme", "the operator filters by tenant"],
      ],
      ["Your app keeps the three consistent.", "Workhorse does not check that they agree."],
    );
    return d.render(this.slug, 400, height, optionsTitle, optionsDescription);
  },
};

const modelsTitle = "Shared tenancy keeps work fair. Isolated tenancy keeps tenants apart";
const modelsDescription =
  "With shared tenancy, acme and globex use one database and one worker fleet, and the app keeps " +
  "the tenant identifier of each task consistent. With isolated tenancy, acme and globex each have " +
  "a database with the Workhorse schema and their own worker fleet. No worker sees the tasks of " +
  "both tenants, and PostgreSQL enforces the boundary.";

/** The model diagram: shared tenancy on the left, isolated tenancy on the right. */
export const tenantModels = {
  slug: "multi-tenancy-models",
  title: modelsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.arrow("M 212,124 V 158");
    d.arrow("M 588,124 V 158");
    d.arrow("M 820,124 V 158");

    d.zone(24, 56, 376, 196, "SHARED TENANCY");
    d.box(40, 76, 344, 48, "backend", "one worker fleet", "runs the tasks of acme and globex", 11);
    d.box(40, 160, 344, 72, "store", "one database", "acme and globex in the same tables", 11);

    d.zone(424, 56, 512, 196, "ISOLATED TENANCY");
    d.box(440, 76, 232, 48, "backend", "worker fleet acme", "connects to acme only", 11);
    d.box(688, 76, 232, 48, "backend", "worker fleet globex", "connects to globex only", 11);
    d.box(440, 160, 232, 72, "focal", "acme database", "own schema and migrations", 11);
    d.box(688, 160, 232, 72, "focal", "globex database", "own schema and migrations", 11);

    d.rows(
      24,
      284,
      [
        [
          "Shared: your app keeps the tenant consistent. Isolated: PostgreSQL enforces the boundary.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 300, modelsTitle, modelsDescription);
  },
};

/** The model diagram for screens up to 600 px wide: one part on each line. */
export const tenantModelsNarrow = {
  slug: "multi-tenancy-models-narrow",
  title: modelsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["shared", "store", "one database, one fleet", "acme and globex together"],
        ["isolated", "focal", "acme database", "its own worker fleet"],
        ["isolated", "focal", "globex database", "its own worker fleet"],
      ],
      [
        "Shared: your app keeps the tenant",
        "consistent. Isolated: PostgreSQL",
        "enforces the boundary.",
      ],
    );
    return d.render(this.slug, 400, height, modelsTitle, modelsDescription);
  },
};
