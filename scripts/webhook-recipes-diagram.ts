import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of the recipe pages `site/content/docs/stripe.mdx`, `site/content/docs/github.mdx`,
 * and `site/content/docs/slack-approvals.mdx` (with `docs/recipes/slack-approvals.md`). Each
 * diagram uses the names of its page.
 *
 * Stripe and GitHub: the receiver verifies the signature over the raw body. In one transaction, it
 * writes the inbox row and enqueues a task whose payload is `{ inboxId }`. It replies only after
 * the commit. The worker then does the effect one time.
 *
 * Slack: the task handler registers `waitForHuman("approval", context)`. The notifier finds the
 * committed wait through `Admin.listHumanWaits` and posts the buttons. The receiver verifies the
 * signed action and commits the first authorized decision within 2,500 ms, before HTTP 200. The
 * decision worker calls `completeHumanWait` with the stored key and actor.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";
type Part = readonly [name: string, sub: string];

function eventList(
  d: Diagram,
  events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[],
  lines: readonly string[],
): number {
  const pitch = 56;
  events.forEach(([label, kind, name, sub], index) => {
    const top = 24 + index * pitch;
    if (index > 0) d.arrow(`M 248,${top - 14} V ${top - 2}`);
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

interface Inbox {
  provider: Part;
  receiver: Part;
  inbox: Part;
  task: Part;
  reply: Part;
  worker: Part;
  footer: string;
}

/** The inbox layout: provider, receiver, one transaction with the inbox row and the task, then the
 * reply and the worker. */
function inboxFlow(d: Diagram, parts: Inbox): number {
  d.arrow("M 176,98 H 198");
  d.arrow("M 368,98 H 406");
  d.arrow("M 624,98 H 662");
  d.arrow("M 624,158 H 662");
  d.zone(392, 48, 248, 156, "ONE TRANSACTION");
  d.box(24, 72, 152, 52, "external", parts.provider[0], parts.provider[1], 11);
  d.box(200, 72, 168, 52, "backend", parts.receiver[0], parts.receiver[1], 11);
  d.box(408, 76, 216, 44, "store", parts.inbox[0], parts.inbox[1], 11);
  d.box(408, 136, 216, 44, "store", parts.task[0], parts.task[1], 11);
  d.box(664, 76, 272, 44, "backend", parts.reply[0], parts.reply[1], 11);
  d.box(664, 136, 272, 44, "focal", parts.worker[0], parts.worker[1], 11);
  d.rows(24, 244, [[parts.footer, 9, "muted", MONO, 400]], "start");
  return 260;
}

const stripeTitle = "One Stripe event becomes one credit, also after a retry";
const stripeDescription =
  "Stripe sends invoice.paid. The receiver verifies the signature. In one transaction, it writes " +
  "the inbox row and enqueues a stripe.invoice-paid task with the payload { inboxId }. It replies " +
  "200 only after the commit. The worker writes the ledger row and adds one credit in one " +
  "transaction. A second delivery finds the inbox row, and a second run finds the ledger row.";

/** The Stripe diagram: one invoice.paid event from Stripe to the credit. */
export const stripeInvoicePaid = {
  slug: "stripe-invoice-paid",
  title: stripeTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = inboxFlow(d, {
      provider: ["Stripe", "invoice.paid"],
      receiver: ["receiver", "verifies the signature"],
      inbox: ["inbox row", "unique account, mode, event"],
      task: ["stripe.invoice-paid", "payload { inboxId }"],
      reply: ["replies 200", "only after the commit"],
      worker: ["worker", "ledger row + one credit"],
      footer:
        "A second delivery finds the inbox row. A second run finds the ledger row. The customer gets one credit.",
    });
    return d.render(this.slug, 960, height, stripeTitle, stripeDescription);
  },
};

/** The Stripe diagram for screens up to 600 px wide: one step on each line. */
export const stripeInvoicePaidNarrow = {
  slug: "stripe-invoice-paid-narrow",
  title: stripeTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["Stripe", "external", "invoice.paid", "a signed webhook"],
        ["receive", "backend", "verify the signature", "the raw body"],
        ["commit", "store", "inbox row + task", "one transaction"],
        ["reply", "backend", "replies 200", "only after the commit"],
        ["worker", "focal", "ledger row + one credit", "one transaction"],
      ],
      ["The customer gets one credit, also", "after a retry."],
    );
    return d.render(this.slug, 400, height, stripeTitle, stripeDescription);
  },
};

const githubTitle = "One GitHub delivery becomes one label task";
const githubDescription =
  "The GitHub App sends issues.opened. The receiver verifies the signature over the raw body and " +
  "checks the repository, the installation, and the issue. In one transaction, it writes the inbox " +
  "row and the intent row and enqueues a github.ensure-label task. It replies 202 only after the " +
  "commit. The worker adds the label if the issue does not have it.";

/** The GitHub diagram: one issues.opened delivery to the label. */
export const githubTriage = {
  slug: "github-triage",
  title: githubTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = inboxFlow(d, {
      provider: ["GitHub App", "issues.opened"],
      receiver: ["receiver", "signature + scope"],
      inbox: ["inbox row + intent row", "one for each issue and label"],
      task: ["github.ensure-label", "payload { inboxId }"],
      reply: ["replies 202", "only after the commit"],
      worker: ["worker", "adds the label if missing"],
      footer:
        "GitHub does not retry a failed delivery. Use the recovery commands to find missed deliveries.",
    });
    return d.render(this.slug, 960, height, githubTitle, githubDescription);
  },
};

/** The GitHub diagram for screens up to 600 px wide: one step on each line. */
export const githubTriageNarrow = {
  slug: "github-triage-narrow",
  title: githubTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["GitHub", "external", "issues.opened", "a signed delivery"],
        ["receive", "backend", "signature + scope", "repository, installation, issue"],
        ["commit", "store", "inbox + intent + task", "one transaction"],
        ["reply", "backend", "replies 202", "only after the commit"],
        ["worker", "focal", "adds the label", "if the issue does not have it"],
      ],
      ["GitHub does not retry a failed", "delivery. Recover missed deliveries."],
    );
    return d.render(this.slug, 400, height, githubTitle, githubDescription);
  },
};

const slackTitle = "Each Slack approval process does one job";
const slackDescription =
  "The task handler registers waitForHuman. The notifier finds the committed wait through " +
  "Admin.listHumanWaits and posts the buttons. A user clicks. The receiver verifies the signed " +
  "action and commits the first authorized decision within 2,500 ms, before HTTP 200. The decision " +
  "worker calls completeHumanWait with the stored key and actor.";

const slackSteps: readonly (readonly [kind: Kind, name: string, sub: string])[] = [
  ["backend", "task handler", "waitForHuman"],
  ["backend", "notifier", "posts the buttons"],
  ["external", "Slack user", "clicks a button"],
  ["store", "receiver", "commits · HTTP 200"],
  ["focal", "decision worker", "completeHumanWait"],
];

const STEP = 168;
const STEP_GAP = 18;
const stepX = (index: number): number => 24 + index * (STEP + STEP_GAP);

/** The Slack diagram: the five processes of one decision, in order. */
export const slackApproval = {
  slug: "slack-approval",
  title: slackTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = 64;
    slackSteps.forEach(([kind, name, sub], index) => {
      if (index > 0) d.arrow(`M ${stepX(index - 1) + STEP},${y + 26} H ${stepX(index) - 2}`);
      d.box(stepX(index), y, STEP, 52, kind, name, sub, 11);
    });
    d.rows(stepX(3) + STEP / 2, y + 76, [["within 2,500 ms", 9, "soft", MONO, 400]]);
    d.rows(
      24,
      y + 112,
      [
        [
          "HTTP 200 confirms a durable receipt. It does not confirm an approval or a task completion.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, y + 128, slackTitle, slackDescription);
  },
};

/** The Slack diagram for screens up to 600 px wide: one process on each line. */
export const slackApprovalNarrow = {
  slug: "slack-approval-narrow",
  title: slackTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["handler", "backend", "waitForHuman", "the task waits"],
        ["notifier", "backend", "posts the buttons", "Admin.listHumanWaits"],
        ["Slack", "external", "a user clicks", "a signed action"],
        ["receiver", "store", "commits the decision", "HTTP 200 within 2,500 ms"],
        ["worker", "focal", "completeHumanWait", "the stored key and actor"],
      ],
      ["HTTP 200 confirms a durable receipt,", "not an approval."],
    );
    return d.render(this.slug, 400, height, slackTitle, slackDescription);
  },
};
