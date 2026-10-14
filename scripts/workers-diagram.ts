import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `docs/guides/310-workers.md`. It uses the names of that guide.
 *
 * "Fill the worker slots": `mailer-1` has a `concurrency` of 8. At start, one claim to `email`
 * for eight tasks fills every slot. When one task finishes and no claim is in flight, the worker
 * claims one task, and the queue rotation sends that claim to `billing`. When two more tasks
 * finish while that claim is in flight, the worker sends a claim to `email` for two tasks. The
 * worker never claims more tasks than it has free slots. One heartbeat timer renews all leases of
 * the worker in one batch.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";
type Slot = readonly [kind: Kind, name: string, sub: string];

const running: Slot = ["backend", "email", "runs"];
const newEmail: Slot = ["store", "email", "claimed now"];
const newBilling: Slot = ["focal", "billing", "claimed now"];

const steps: readonly (readonly [label: string, claim: string, slots: readonly Slot[]])[] = [
  ["1 · start", "claim email × 8", Array.from({ length: 8 }, () => newEmail)],
  [
    "2 · 1 finishes",
    "claim billing × 1",
    [newBilling, ...Array.from({ length: 7 }, () => running)],
  ],
  [
    "3 · 2 more finish",
    "claim email × 2",
    [
      ["backend", "billing", "runs"],
      newEmail,
      newEmail,
      ...Array.from({ length: 5 }, () => running),
    ],
  ],
];

const title = "A worker fills its free slots with as few claims as possible";
const description =
  "mailer-1 has eight slots. At start, one claim to email for eight tasks fills every slot. One task " +
  "finishes, and the worker claims one task; the queue rotation sends this claim to billing. Two " +
  "more tasks finish while that claim is in flight, so the worker claims two tasks from email. One " +
  "heartbeat timer renews all leases of the worker in one batch.";

const SLOT = 84;
const slotX = (index: number): number => 200 + index * (SLOT + 8);

/** The slot diagram: one row for each step, one column for each slot. */
export const workerSlots = {
  slug: "workers-slots",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(
      24,
      40,
      [
        ["mailer-1", 12, "ink", SANS, 600],
        ["concurrency 8 · email, billing", 9, "muted", MONO, 400],
      ],
      "start",
    );
    for (let index = 0; index < 8; index += 1) {
      d.rows(slotX(index) + SLOT / 2, 44, [[`slot ${index + 1}`, 8, "soft", MONO, 400]]);
    }
    d.divider(200, slotX(7) + SLOT, 52);

    steps.forEach(([label, claim, slots], row) => {
      const y = 72 + row * 56;
      d.rows(
        24,
        y + 16,
        [
          [label, 11, "ink", SANS, 600],
          [claim, 9, "muted", MONO, 400],
        ],
        "start",
      );
      slots.forEach(([kind, name, sub], index) => {
        d.box(slotX(index), y, SLOT, 40, kind, name, sub, 10);
      });
    });

    const heartbeatY = 72 + steps.length * 56;
    d.box(
      200,
      heartbeatY,
      slotX(7) + SLOT - 200,
      36,
      "store",
      "one heartbeat timer renews all leases in one batch",
      undefined,
      10,
    );

    d.rows(
      24,
      heartbeatY + 64,
      [
        [
          "The worker never claims more tasks than it has free slots, and each claim rotates to the next queue.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, heartbeatY + 80, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["start", "store", "claim email × 8", "every slot is full"],
  ["1 ends", "focal", "claim billing × 1", "the next queue in turn"],
  ["2 end", "store", "claim email × 2", "while the billing claim runs"],
  ["always", "store", "one heartbeat timer", "renews all leases in one batch"],
];

/** The slot diagram for screens up to 600 px wide: one claim on each line. */
export const workerSlotsNarrow = {
  slug: "workers-slots-narrow",
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
        ["The worker never claims more tasks", 9, "muted", MONO, 400],
        ["than it has free slots.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
