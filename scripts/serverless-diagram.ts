import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/395-serverless-web-tiers.md`. They use the names of that guide.
 *
 * "Check what each runtime can do": a worker needs a continuous process, and a producer needs a
 * supported client and a PostgreSQL session. A Node.js function can enqueue in the same transaction
 * as its data, but a request or event invocation cannot host a worker. An edge isolate does not
 * have the Node.js networking APIs that `pg` needs, so it cannot use the published client. Only a
 * runtime with a continuous process can host a worker.
 *
 * "Run the worker in a continuous process": the checkout on Vercel commits `order-42` and its
 * `order.fulfill` task. `workhorse worker` on a Cloud Run worker pool claims the task from the same
 * PostgreSQL database, and on a termination signal it stops claims and drains.
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

const runtimesTitle = "A Node.js function can enqueue; only a continuous process can host a worker";
const runtimesDescription =
  "A Node.js function on Vercel, AWS Lambda, or a Cloud Run service can enqueue in the same " +
  "transaction as its data, but it cannot host a worker, because it has no continuous process. An " +
  "edge isolate, such as Vercel Edge or Cloudflare Workers, cannot use the published client. A " +
  "continuous process, such as a Cloud Run worker pool, a virtual machine, or Kubernetes, can host " +
  "a worker.";

const runtimes: readonly (readonly [
  name: string,
  examples: string,
  enqueue: readonly [Kind, string, string],
  worker: readonly [Kind, string, string],
])[] = [
  [
    "Node.js function",
    "Vercel · Lambda · Cloud Run service",
    ["backend", "can enqueue", "in the same transaction"],
    ["external", "cannot host a worker", "no continuous process"],
  ],
  [
    "edge isolate",
    "Vercel Edge · Cloudflare Workers",
    ["external", "cannot enqueue", "no published client"],
    ["external", "cannot host a worker", "no continuous process"],
  ],
  [
    "continuous process",
    "Cloud Run worker pool · VM",
    ["backend", "can enqueue", "a Node.js process"],
    ["focal", "hosts the worker", "renews leases · drains"],
  ],
];

/** The runtime diagram: one row for each kind of runtime, one column for each role. */
export const serverlessRuntimes = {
  slug: "serverless-runtimes",
  title: runtimesTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const cols = [320, 632] as const;
    const width = 296;
    ["enqueue · a producer", "run a worker"].forEach((heading, index) => {
      d.rows(cols[index]! + width / 2, 44, [[heading, 8, "soft", MONO, 400]]);
    });
    d.divider(320, 928, 52);
    runtimes.forEach(([name, examples, enqueue, worker], index) => {
      const y = 72 + index * 56;
      d.rows(
        24,
        y + 16,
        [
          [name, 11, "ink", SANS, 600],
          [examples, 9, "muted", MONO, 400],
        ],
        "start",
      );
      [enqueue, worker].forEach(([kind, label, sub], col) => {
        d.box(cols[col]!, y, width, 40, kind, label, sub, 11);
      });
    });
    const footerY = 72 + runtimes.length * 56 + 24;
    d.rows(
      24,
      footerY,
      [
        [
          "Check the process lifetime first. A runtime can reach PostgreSQL and still be unable to run a worker.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, footerY + 16, runtimesTitle, runtimesDescription);
  },
};

/** The runtime diagram for screens up to 600 px wide: one runtime on each line. */
export const serverlessRuntimesNarrow = {
  slug: "serverless-runtimes-narrow",
  title: runtimesTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["function", "backend", "Node.js function", "can enqueue · no worker"],
        ["edge", "external", "edge isolate", "no published client · no worker"],
        ["process", "focal", "continuous process", "hosts the worker"],
      ],
      ["Check the process lifetime first."],
    );
    return d.render(this.slug, 400, height, runtimesTitle, runtimesDescription);
  },
};

const tiersTitle = "The web tier and the worker tier meet only in PostgreSQL";
const tiersDescription =
  "The checkout runs on Vercel Node.js. It commits order-42 and its order.fulfill task in one " +
  "transaction. workhorse worker runs on a Cloud Run worker pool and connects to the same " +
  "PostgreSQL database. It claims the task and runs the handler. During a deployment, the old " +
  "worker gets a termination signal, stops claims, and lets active handlers finish.";

/** The tier diagram: the serverless web tier, PostgreSQL, and the continuous worker tier. */
export const serverlessTiers = {
  slug: "serverless-tiers",
  title: tiersTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.arrow("M 296,124 H 362");
    d.arrow("M 664,124 H 598");
    d.label(330, 104, "COMMIT");
    d.label(631, 104, "CLAIM");

    d.zone(24, 56, 272, 152, "WEB TIER · VERCEL NODE.JS");
    d.box(40, 76, 240, 48, "backend", "checkout route", "a request invocation", 11);
    d.box(40, 140, 240, 52, "store", "order-42 + order.fulfill", "one transaction", 11);

    d.box(364, 92, 232, 64, "store", "PostgreSQL", "the same database", 11);

    d.zone(664, 56, 272, 152, "WORKER TIER · CLOUD RUN WORKER POOL");
    d.box(680, 76, 240, 48, "focal", "workhorse worker", "a continuous process", 11);
    d.box(680, 140, 240, 52, "backend", "termination signal", "stops claims · drains", 11);

    d.rows(
      24,
      244,
      [
        [
          "Keep request handlers on the serverless platform. Run the worker on compute that keeps a process.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 260, tiersTitle, tiersDescription);
  },
};

/** The tier diagram for screens up to 600 px wide: one part on each line. */
export const serverlessTiersNarrow = {
  slug: "serverless-tiers-narrow",
  title: tiersTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["web", "backend", "checkout on Vercel Node.js", "commits order-42 and its task"],
        ["database", "store", "PostgreSQL", "the only shared part"],
        ["worker", "focal", "workhorse worker", "Cloud Run worker pool"],
        ["deploy", "backend", "termination signal", "stops claims · drains"],
      ],
      ["The two tiers meet only in PostgreSQL."],
    );
    return d.render(this.slug, 400, height, tiersTitle, tiersDescription);
  },
};
