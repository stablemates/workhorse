import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `site/content/docs/integrations.mdx` and `site/content/docs/frameworks.mdx`.
 * Each diagram uses the names of its page.
 *
 * Integrations, "What all integrations have in common": Workhorse needs a way to run a
 * parameterized SQL query, the `Queryable` protocol. Each integration converts the database object
 * or the transaction object that your code already has. With your open transaction, `enqueue`
 * writes the task in that transaction, and a rollback removes the task too. Workhorse never opens a
 * transaction for you. Workers always run in their own process.
 *
 * Frameworks: the worker runs in its own process. The request code gets the `Queue` from the
 * dependency injection of the framework and enqueues in the transaction that writes its data. The
 * dashboard mounts in one of two shapes: `host.handle(request)` for a Fetch `Request`, or
 * `dashboardNodeMiddleware(host)` for a Node `req`/`res` pair.
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

const commonTitle = "Each integration gives Workhorse your transaction";
const commonDescription =
  "Your ORM or driver already has a transaction object. The integration converts it to the " +
  "Queryable protocol, a way to run a parameterized SQL query. enqueue writes the task in that " +
  "transaction. If the transaction commits, the data and the task commit together. If it rolls " +
  "back, PostgreSQL removes the task too. Workers always run in their own process.";

/** The common diagram: from your transaction object to the enqueue, then commit or rollback. */
export const integrationsCommon = {
  slug: "integrations-common",
  title: commonTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.arrow("M 200,74 H 222");
    d.arrow("M 400,74 H 422");
    d.arrow("M 600,74 H 622");
    d.arrow("M 704,100 V 134");
    d.arrow("M 856,100 V 134");
    d.box(24, 48, 176, 52, "external", "your transaction", "from your ORM or driver", 11);
    d.box(224, 48, 176, 52, "backend", "the integration", "converts the object", 11);
    d.box(424, 48, 176, 52, "focal", "Queryable", "a parameterized query", 11);
    d.box(624, 48, 312, 52, "store", "enqueue", "writes the task in your transaction", 11);
    d.box(624, 136, 148, 48, "backend", "commit", "data + task", 11);
    d.box(788, 136, 148, 48, "external", "rollback", "the task is gone", 11);
    d.box(
      24,
      136,
      576,
      48,
      "backend",
      "worker",
      "always in its own process · never in a web request",
      11,
    );
    d.rows(
      24,
      216,
      [["Workhorse never opens a transaction for you.", 9, "muted", MONO, 400]],
      "start",
    );
    return d.render(this.slug, 960, 232, commonTitle, commonDescription);
  },
};

/** The common diagram for screens up to 600 px wide: one part on each line. */
export const integrationsCommonNarrow = {
  slug: "integrations-common-narrow",
  title: commonTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["yours", "external", "your transaction", "from your ORM or driver"],
        ["adapter", "focal", "Queryable", "a parameterized query"],
        ["enqueue", "store", "writes in your transaction", "commit: data + task"],
        ["", "external", "rollback", "the task is gone"],
        ["worker", "backend", "its own process", "never in a web request"],
      ],
      ["Workhorse never opens a transaction", "for you."],
    );
    return d.render(this.slug, 400, height, commonTitle, commonDescription);
  },
};

const shapeTitle = "The web process enqueues and serves the dashboard; the worker runs alone";
const shapeDescription =
  "In the web process, the request handler gets the Queue from the dependency injection of your " +
  "framework and enqueues in the transaction that writes its data. The dashboard mounts in one of " +
  "two shapes: host.handle(request) for a Fetch Request, or dashboardNodeMiddleware(host) for a " +
  "Node req and res pair. The worker runs as its own continuous process. Both connect to PostgreSQL.";

/** The shape diagram: the web process, the worker process, and PostgreSQL. */
export const frameworksShape = {
  slug: "frameworks-shape",
  title: shapeTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.zone(24, 48, 568, 180, "WEB PROCESS");
    d.zone(616, 48, 320, 180, "WORKER PROCESS");
    d.arrow("M 284,100 H 318");
    d.arrow("M 304,228 V 258");
    d.arrow("M 776,228 V 258");
    d.box(40, 76, 244, 48, "backend", "request handler", "writes your data", 11);
    d.box(320, 76, 256, 48, "focal", "Queue from your DI", "enqueues in that transaction", 11);
    d.rows(40, 150, [["the dashboard · one of two shapes", 8, "soft", MONO, 400]], "start");
    d.box(40, 160, 260, 52, "backend", "Fetch Request", "host.handle(request)", 11);
    d.box(316, 160, 260, 52, "backend", "Node req / res", "dashboardNodeMiddleware(host)", 11);
    d.box(632, 76, 288, 48, "backend", "workhorse worker", "a continuous process", 11);
    d.box(632, 140, 288, 72, "store", "its own pool", "renews leases · drains on a signal", 11);
    d.box(24, 260, 912, 40, "store", "PostgreSQL", undefined, 11);
    d.rows(
      24,
      332,
      [
        [
          "A web replica never starts a worker. Scale the web tier and the worker tier separately.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 348, shapeTitle, shapeDescription);
  },
};

/** The shape diagram for screens up to 600 px wide: one part on each line. */
export const frameworksShapeNarrow = {
  slug: "frameworks-shape-narrow",
  title: shapeTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["web", "focal", "Queue from your DI", "enqueues in that transaction"],
        ["web", "backend", "Fetch Request", "host.handle(request)"],
        ["web", "backend", "Node req / res", "dashboardNodeMiddleware(host)"],
        ["worker", "backend", "workhorse worker", "its own process and pool"],
      ],
      ["A web replica never starts a worker."],
    );
    return d.render(this.slug, 400, height, shapeTitle, shapeDescription);
  },
};
