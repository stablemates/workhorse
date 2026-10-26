import { describe, expect, it, vi } from "vitest";
import {
  checkpointInputFingerprint,
  HandlerReplayError,
  replayHandler,
  type DurableState,
} from "../src/index.js";
import type { Json } from "../src/types.js";
import type { Handler } from "../src/worker.js";

type Order = { orderId: string };

// The state that the old `order.ship` code stored: it reserved stock and waits for the payment.
const waitingForPayment: DurableState = {
  checkpoints: { reserve: { value: { reservationId: "r-1" } } },
  signals: { "payment-cleared": { pending: true } },
};

function warehouse() {
  return {
    reserve: vi.fn<() => Promise<Json>>(async () => ({ reservationId: "r-2" })),
    ship: vi.fn<() => Promise<Json>>(async () => ({ shipmentId: "s-1" })),
  };
}

async function replayError(run: Promise<unknown>): Promise<HandlerReplayError> {
  const error: unknown = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(HandlerReplayError);
  return error as HandlerReplayError;
}

const catchesTheReplayError: Handler<Order> = async (payload, ctx) => {
  await ctx.checkpoint("audit", () => "logged").catch(() => null);
  await ctx.checkpoint("reserve", () => "r-3");
  return null;
};

const sleepsUntilTen: Handler<Order> = async (payload, ctx) => {
  await ctx.sleepUntil("ship-window", new Date("2026-10-12T10:00:00.000Z"));
  return null;
};

const sleepsRelative: Handler<Order> = async (payload, ctx) => {
  await ctx.sleep("cooldown", 120_000);
  return "done";
};

const sleepsAbsolute: Handler<Order> = async (payload, ctx) => {
  await ctx.sleepUntil("cooldown", new Date("2026-10-12T09:01:00.000Z"));
  return "done";
};

const changesTheChild: Handler<Order> = async (payload, ctx) =>
  ctx.runChild("label", "label.print", { orderId: "o-1", copies: 2 });

const changesTheContext: Handler<Order> = async (payload, ctx) => {
  await ctx.runChild("label", "label.print", { orderId: "o-1" });
  return ctx.waitForHuman("approve", { amount: 20 });
};

const dropsTheReservation: Handler<Order> = async (payload, ctx) => {
  await ctx.waitForSignal("payment-cleared");
  return null;
};

const startsTwoChildren: Handler<Order> = async (payload, ctx) => {
  await ctx.checkpoint("reserve", () => "r-3");
  await ctx.runChildren([
    { name: "label", type: "label.print", payload: null },
    { name: "invoice", type: "invoice.send", payload: null },
  ]);
  return null;
};

const joinsTwoChildren: Handler<Order> = async (payload, ctx) =>
  ctx.runChildren([
    { name: "label", type: "label.print", payload: null, options: { priority: 5 } },
    { name: "invoice", type: "invoice.send", payload: null },
  ]);

const joinsAllChildren: Handler<Order> = async (payload, ctx) =>
  ctx.runChildrenAll([{ name: "label", type: "label.print", payload: null }]);

const joinsSettledChildren: Handler<Order> = async (payload, ctx) =>
  ctx.runChildren([{ name: "label", type: "label.print", payload: null }]);

const runsTheLabelChild: Handler<Order> = async (payload, ctx) =>
  ctx.runChild("label", "label.print", null);

const overlapsTwoLabelRequests: Handler<Order> = async (payload, ctx) =>
  Promise.all([
    ctx.runChild("label", "label.print", { copies: 1 }),
    ctx.runChild("label", "label.print", { copies: 2 }),
  ]);

const repeatsAChildName: Handler<Order> = async (payload, ctx) =>
  ctx.runChildren([
    { name: "label", type: "label.print", payload: null },
    { name: "label", type: "label.print", payload: null },
  ]);

const joinsOneOfTwoChildren: Handler<Order> = async (payload, ctx) =>
  ctx.runChildren([{ name: "label", type: "label.print", payload: null }]);

const renamesTheLabelChild: Handler<Order> = async (payload, ctx) =>
  ctx.runChild("print-label", "label.print", null);

const overlapsTwoApprovalContexts: Handler<Order> = async (payload, ctx) =>
  Promise.all([
    ctx.waitForHuman("approve", { amount: 10 }),
    ctx.waitForHuman("approve", { amount: 20 }),
  ]);

// A live handler compares the cloned child arrays, so omitted options differ from empty options.
const overlapsTwoLabelSets: Handler<Order> = async (payload, ctx) =>
  Promise.all([
    ctx.runChildren([{ name: "label", type: "label.print", payload: null }]),
    ctx.runChildren([{ name: "label", type: "label.print", payload: null, options: {} }]),
  ]);

const readsTheLookupFingerprint: Handler<Order> = async (payload, ctx) =>
  (await ctx.getCheckpoint("lookup"))?.inputFingerprint ?? null;

const rawJSON = (JSON as unknown as { rawJSON(text: string): Json }).rawJSON;

// A human context whose number is a JSON.rawJSON token, and a stored context with the same key.
const approvesCopies =
  (token: string): Handler<Order> =>
  async (payload, ctx) =>
    ctx.waitForHuman("approve", { copies: rawJSON(token) });
const storedCopies = (copies: Json): DurableState => ({
  humanWaits: { approve: { context: { copies }, result: "approved" } },
});

// A child request and a human context with one escaped key, and the stored values of the same
// request. The stored values put the key first, so they do not have the shape of the request.
const asksFor =
  (key: string): Handler<Order> =>
  async (payload, ctx) => {
    await ctx.runChild("label", "label.print", { printerId: "p-1", [key]: 1 });
    return ctx.waitForHuman("approve", { approverId: "a-1", [key]: 1 });
  };
const storedFor = (key: string): DurableState => ({
  children: {
    label: {
      type: "label.print",
      payload: { [key]: 1, printerId: "p-1" },
      outcome: { status: "succeeded", result: "label-1" },
    },
  },
  humanWaits: { approve: { context: { [key]: 1, approverId: "a-1" }, result: "approved" } },
});

function storedLabel(set: "settled" | "all_success" | undefined): DurableState {
  return {
    children: {
      label: {
        type: "label.print",
        payload: null,
        ...(set === undefined ? {} : { set }),
        outcome: { status: "succeeded", result: "label-1" },
      },
    },
  };
}

describe("replayHandler", () => {
  it("replays unchanged code to the point where the task suspended", async () => {
    const stock = warehouse();
    const handler: Handler<Order> = async (payload, ctx) => {
      await ctx.checkpoint("reserve", () => stock.reserve());
      await ctx.waitForSignal("payment-cleared");
      return ctx.checkpoint("ship", () => stock.ship());
    };

    const report = await replayHandler(handler, { orderId: "o-1" }, waitingForPayment);

    expect(report).toEqual({
      replayed: [
        { kind: "checkpoint", name: "reserve" },
        { kind: "signal", name: "payment-cleared" },
      ],
      new: [],
      unused: [],
      outcome: { status: "suspended", at: { kind: "signal", name: "payment-cleared" } },
    });
    expect(stock.reserve).not.toHaveBeenCalled();
    expect(stock.ship).not.toHaveBeenCalled();
  });

  it("runs a new checkpoint after every stored name and returns the result", async () => {
    const stock = warehouse();
    const handler: Handler<Order> = async (payload, ctx) => {
      const reservation = await ctx.checkpoint("reserve", () => stock.reserve());
      const payment = await ctx.waitForSignal<{ amount: number }>("payment-cleared");
      const shipment = await ctx.checkpoint("ship", () => stock.ship());
      return { reservation, payment, shipment };
    };
    const delivered: DurableState = {
      ...waitingForPayment,
      signals: { "payment-cleared": { payload: { amount: 10 } } },
    };

    const report = await replayHandler(handler, { orderId: "o-1" }, delivered);

    expect(report.new).toEqual([{ kind: "checkpoint", name: "ship" }]);
    expect(report.outcome).toEqual({
      status: "completed",
      result: {
        reservation: { reservationId: "r-1" },
        payment: { amount: 10 },
        shipment: { shipmentId: "s-1" },
      },
    });
    expect(stock.reserve).not.toHaveBeenCalled();
    expect(stock.ship).toHaveBeenCalledOnce();
  });

  it("fails on a renamed checkpoint before its operation runs", async () => {
    const stock = warehouse();
    const handler: Handler<Order> = async (payload, ctx) => {
      await ctx.checkpoint("reserve-stock", () => stock.reserve());
      await ctx.waitForSignal("payment-cleared");
      return null;
    };

    const error = await replayError(replayHandler(handler, { orderId: "o-1" }, waitingForPayment));

    expect(error.problem).toEqual({
      reason: "new_before_stored",
      at: { kind: "checkpoint", name: "reserve-stock" },
    });
    expect(error.names).toEqual({
      replayed: [],
      new: [{ kind: "checkpoint", name: "reserve-stock" }],
      unused: [
        { kind: "checkpoint", name: "reserve" },
        { kind: "signal", name: "payment-cleared" },
      ],
    });
    expect(error.message).toContain('checkpoint "reserve"');
    expect(stock.reserve).not.toHaveBeenCalled();
  });

  it("fails on a checkpoint added before a stored wait", async () => {
    const stock = warehouse();
    const audit = vi.fn<() => string>(() => "logged");
    const handler: Handler<Order> = async (payload, ctx) => {
      await ctx.checkpoint("reserve", () => stock.reserve());
      await ctx.checkpoint("audit", audit);
      await ctx.waitForSignal("payment-cleared");
      return null;
    };

    const error = await replayError(replayHandler(handler, { orderId: "o-1" }, waitingForPayment));

    expect(error.problem).toEqual({
      reason: "new_before_stored",
      at: { kind: "checkpoint", name: "audit" },
    });
    expect(error.names.replayed).toEqual([{ kind: "checkpoint", name: "reserve" }]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("fails when the handler catches the replay error and continues", async () => {
    const error = await replayError(
      replayHandler(catchesTheReplayError, { orderId: "o-1" }, waitingForPayment),
    );

    expect(error.problem.at).toEqual({ kind: "checkpoint", name: "audit" });
  });

  it("fails when a stored absolute wait target conflicts", async () => {
    const state: DurableState = {
      waits: { "ship-window": { mode: "absolute", wakeAt: "2026-10-12T09:00:00.000Z" } },
    };

    const error = await replayError(replayHandler(sleepsUntilTen, { orderId: "o-1" }, state));

    expect(error.problem).toEqual({
      reason: "conflict",
      at: { kind: "wait", name: "ship-window" },
    });
    expect(error.message).toContain("2026-10-12T09:00:00.000Z");
  });

  it("fails when a wait changes its mode, and keeps a changed relative duration", async () => {
    const state: DurableState = {
      waits: {
        cooldown: { mode: "relative", durationMs: 60_000, wakeAt: "2026-10-12T09:01:00.000Z" },
      },
    };

    const report = await replayHandler(sleepsRelative, { orderId: "o-1" }, state);
    const error = await replayError(replayHandler(sleepsAbsolute, { orderId: "o-1" }, state));

    expect(report.outcome).toEqual({ status: "completed", result: "done" });
    expect(error.problem.reason).toBe("conflict");
  });

  it("fails when a child request or a human decision context conflicts", async () => {
    const state: DurableState = {
      children: {
        label: {
          type: "label.print",
          payload: { orderId: "o-1" },
          outcome: { status: "succeeded", result: "label-1" },
        },
      },
      humanWaits: { approve: { context: { amount: 10 }, pending: true } },
    };

    const child = await replayError(replayHandler(changesTheChild, { orderId: "o-1" }, state));
    const human = await replayError(replayHandler(changesTheContext, { orderId: "o-1" }, state));

    expect(child.problem).toEqual({ reason: "conflict", at: { kind: "child", name: "label" } });
    expect(human.problem).toEqual({
      reason: "conflict",
      at: { kind: "humanWait", name: "approve" },
    });
  });

  it("compares a stored child request and a human context with escaped keys", async () => {
    // Before Node 24.22.1 and 26.12.1, JSON.parse can read the key '"' as the key "\\" that an
    // earlier parse made after the same key. The key names occur in no other test of this file.
    const completed = { outcome: { status: "completed", result: "approved" } };

    await expect(
      replayHandler(asksFor("\\"), { orderId: "o-1" }, storedFor("\\")),
    ).resolves.toMatchObject(completed);
    await expect(
      replayHandler(asksFor('"'), { orderId: "o-1" }, storedFor('"')),
    ).resolves.toMatchObject(completed);
    await expect(
      replayHandler(asksFor('"'), { orderId: "o-1" }, storedFor("\\")),
    ).rejects.toMatchObject({
      problem: { reason: "conflict", at: { kind: "child", name: "label" } },
    });
  });

  it("compares a human context as JSON.stringify writes it", async () => {
    // A raw JSON number and a getter that reads an earlier getter keep their JSON.stringify value.
    let copies = 1;
    const context = {
      get printed() {
        copies = 2;
        return rawJSON("1.0");
      },
      get copies() {
        return copies;
      },
    };
    const approves: Handler<Order> = async (payload, ctx) => ctx.waitForHuman("approve", context);
    const state: DurableState = {
      humanWaits: { approve: { context: { copies: 2, printed: 1 }, result: "approved" } },
    };

    await expect(replayHandler(approves, { orderId: "o-1" }, state)).resolves.toMatchObject({
      outcome: { status: "completed", result: "approved" },
    });
  });

  it("keeps -0 and a number beyond the double range apart from 0 and null", async () => {
    for (const [token, copies] of [
      ["-0", 0],
      ["1e400", null],
      ["-1e400", null],
    ] as const) {
      await expect(
        replayHandler(approvesCopies(token), { orderId: "o-1" }, storedCopies(copies)),
      ).rejects.toMatchObject({
        problem: { reason: "conflict", at: { kind: "humanWait", name: "approve" } },
      });
    }
    await expect(
      replayHandler(approvesCopies("1e400"), { orderId: "o-1" }, storedCopies(rawJSON("1e999"))),
    ).resolves.toMatchObject({ outcome: { status: "completed", result: "approved" } });
  });

  it("accepts an added version checkpoint that allowNew names", async () => {
    const stock = warehouse();
    const handler: Handler<Order> = async (payload, ctx) => {
      const startedOnVersion1 = (await ctx.getCheckpoint("reserve")) !== null;
      const version = await ctx.checkpoint("code-version", () => (startedOnVersion1 ? 1 : 2));
      if (version === 1) await ctx.checkpoint("reserve", () => stock.reserve());
      await ctx.waitForSignal("payment-cleared");
      return null;
    };

    const rejected = await replayError(
      replayHandler(handler, { orderId: "o-1" }, waitingForPayment),
    );
    const report = await replayHandler(handler, { orderId: "o-1" }, waitingForPayment, {
      allowNew: ["code-version"],
    });

    expect(rejected.problem.at).toEqual({ kind: "checkpoint", name: "code-version" });
    expect(report.new).toEqual([{ kind: "checkpoint", name: "code-version" }]);
    expect(report.outcome).toEqual({
      status: "suspended",
      at: { kind: "signal", name: "payment-cleared" },
    });
    expect(stock.reserve).not.toHaveBeenCalled();
  });

  it("reports a stored checkpoint that the new code no longer asks for", async () => {
    const report = await replayHandler(dropsTheReservation, { orderId: "o-1" }, waitingForPayment);

    expect(report.unused).toEqual([{ kind: "checkpoint", name: "reserve" }]);
    expect(report.outcome.status).toBe("suspended");
  });

  it("stops at a new wait or child after every stored name", async () => {
    const state: DurableState = { checkpoints: { reserve: { value: "r-1" } } };

    const report = await replayHandler(startsTwoChildren, { orderId: "o-1" }, state);

    expect(report.new).toEqual([
      { kind: "child", name: "label" },
      { kind: "child", name: "invoice" },
    ]);
    expect(report.outcome).toEqual({ status: "suspended", at: { kind: "child", name: "label" } });
  });

  it("returns stored child set outcomes and accepts a fixture from JSON", async () => {
    const fixture = JSON.stringify({
      children: {
        label: {
          type: "label.print",
          payload: null,
          options: { priority: 5 },
          set: "settled",
          outcome: { status: "succeeded", result: "label-1" },
        },
        invoice: {
          type: "invoice.send",
          payload: null,
          set: "settled",
          outcome: { status: "failed", error: { message: "smtp" } },
        },
      },
    });

    const report = await replayHandler(joinsTwoChildren, { orderId: "o-1" }, JSON.parse(fixture));

    expect(report.outcome).toEqual({
      status: "completed",
      result: {
        label: { status: "succeeded", result: "label-1" },
        invoice: { status: "failed", error: { message: "smtp" } },
      },
    });
  });

  it("passes an error that the handler throws to the caller", async () => {
    const failure = new Error("carrier down");
    const handler: Handler<Order> = async (payload, ctx) => {
      await ctx.checkpoint("reserve", () => "r-3");
      throw failure;
    };

    await expect(replayHandler(handler, { orderId: "o-1" }, waitingForPayment)).rejects.toBe(
      failure,
    );
  });

  it("joins overlapping calls with one name and runs the operation once", async () => {
    const operation = vi.fn<() => Promise<string>>(async () => "value");
    const handler: Handler<Order> = async (payload, ctx) => {
      const [first, second] = await Promise.all([
        ctx.checkpoint("lookup", operation),
        ctx.checkpoint("lookup", operation),
      ]);
      return [first, second];
    };

    const report = await replayHandler(handler, { orderId: "o-1" }, {});

    expect(operation).toHaveBeenCalledOnce();
    expect(report.new).toEqual([{ kind: "checkpoint", name: "lookup" }]);
    expect(report.outcome).toEqual({ status: "completed", result: ["value", "value"] });
  });

  it("compares a checkpoint input with the stored input fingerprint", async () => {
    const charge = { amountCents: 1000 };
    const state: DurableState = {
      checkpoints: {
        "charge-card": {
          value: { chargeId: "c-1" },
          inputFingerprint: checkpointInputFingerprint(charge),
        },
      },
    };
    const chargeCard = vi.fn<() => Json>(() => ({ chargeId: "c-2" }));
    const charges =
      (input: Json | undefined): Handler<Order> =>
      async (payload, ctx) =>
        ctx.checkpoint("charge-card", chargeCard, input === undefined ? {} : { input });

    const same = await replayHandler(charges({ amountCents: 1000 }), { orderId: "o-1" }, state);
    expect(same.outcome).toEqual({ status: "completed", result: { chargeId: "c-1" } });
    const noInput = await replayHandler(charges(undefined), { orderId: "o-1" }, state);
    expect(noInput.outcome).toEqual({ status: "completed", result: { chargeId: "c-1" } });
    const unrecorded = await replayHandler(
      charges({ amountCents: 900 }),
      { orderId: "o-1" },
      { checkpoints: { "charge-card": { value: { chargeId: "c-1" } } } },
    );
    expect(unrecorded.outcome).toEqual({ status: "completed", result: { chargeId: "c-1" } });

    const error = await replayError(
      replayHandler(charges({ amountCents: 900 }), { orderId: "o-1" }, state),
    );
    expect(error.problem).toEqual({
      reason: "conflict",
      at: { kind: "checkpoint", name: "charge-card" },
    });
    expect(error.message).toContain("the input of the stored result");
    expect(chargeCard).not.toHaveBeenCalled();
  });

  it("compares the inputs of repeated and overlapping calls with one new name", async () => {
    const operation = vi.fn<() => Promise<string>>(async () => "value");
    const repeats: Handler<Order> = async (payload, ctx) => {
      await ctx.checkpoint("lookup", operation, { input: 1 });
      return ctx.checkpoint("lookup", operation, { input: 2 });
    };
    const overlaps: Handler<Order> = async (payload, ctx) =>
      Promise.all([
        ctx.checkpoint("lookup", operation, { input: 1 }),
        ctx.checkpoint("lookup", operation, { input: 2 }),
      ]);

    for (const handler of [repeats, overlaps]) {
      const error = await replayError(replayHandler(handler, { orderId: "o-1" }, {}));
      expect(error.problem).toEqual({
        reason: "conflict",
        at: { kind: "checkpoint", name: "lookup" },
      });
      expect(error.message).toContain("an earlier call in this replay");
    }
  });

  it("reads the stored input fingerprint through getCheckpoint", async () => {
    const fingerprint = checkpointInputFingerprint("v1");

    const report = await replayHandler(
      readsTheLookupFingerprint,
      { orderId: "o-1" },
      { checkpoints: { lookup: { value: 1, inputFingerprint: fingerprint } } },
    );

    expect(report.outcome).toEqual({ status: "completed", result: fingerprint });
  });

  it("fails when a child set changes its join mode or its call", async () => {
    const allToSettled = await replayError(
      replayHandler(joinsSettledChildren, { orderId: "o-1" }, storedLabel("all_success")),
    );
    const settledToAll = await replayError(
      replayHandler(joinsAllChildren, { orderId: "o-1" }, storedLabel("settled")),
    );
    const singleToSet = await replayError(
      replayHandler(joinsSettledChildren, { orderId: "o-1" }, storedLabel(undefined)),
    );
    const setToSingle = await replayError(
      replayHandler(runsTheLabelChild, { orderId: "o-1" }, storedLabel("settled")),
    );
    const unchanged = await replayHandler(
      joinsAllChildren,
      { orderId: "o-1" },
      storedLabel("all_success"),
    );

    for (const error of [allToSettled, settledToAll, singleToSet, setToSingle]) {
      expect(error.problem).toEqual({ reason: "conflict", at: { kind: "child", name: "label" } });
    }
    expect(allToSettled.message).toContain("runChildrenAll");
    expect(unchanged.outcome).toEqual({ status: "completed", result: { label: "label-1" } });
  });

  it("fails when a child set omits a stored child", async () => {
    const state: DurableState = {
      children: {
        label: { type: "label.print", payload: null, set: "settled" },
        invoice: { type: "invoice.send", payload: null, set: "settled" },
      },
    };

    const error = await replayError(
      replayHandler(joinsOneOfTwoChildren, { orderId: "o-1" }, state),
    );

    expect(error.problem).toEqual({ reason: "conflict", at: { kind: "child", name: "invoice" } });
  });

  it("fails on overlapping child calls with different requests and on repeated set names", async () => {
    const overlap = await replayError(
      replayHandler(overlapsTwoLabelRequests, { orderId: "o-1" }, {}),
    );

    expect(overlap.problem).toEqual({ reason: "conflict", at: { kind: "child", name: "label" } });
    await expect(replayHandler(repeatsAChildName, { orderId: "o-1" }, {})).rejects.toThrow(
      new TypeError("Child names must be unique"),
    );
  });

  it("fails when runChild asks for a second child name", async () => {
    const error = await replayError(
      replayHandler(renamesTheLabelChild, { orderId: "o-1" }, storedLabel(undefined)),
    );

    expect(error.problem).toEqual({
      reason: "conflict",
      at: { kind: "child", name: "print-label" },
    });
    expect(error.message).toContain('child "label"');
  });

  it("compares overlapping human waits and child sets as a live handler does", async () => {
    const human = await replayError(
      replayHandler(overlapsTwoApprovalContexts, { orderId: "o-1" }, {}),
    );
    const set = await replayError(replayHandler(overlapsTwoLabelSets, { orderId: "o-1" }, {}));

    expect(human.problem).toEqual({
      reason: "conflict",
      at: { kind: "humanWait", name: "approve" },
    });
    expect(set.problem).toEqual({ reason: "conflict", at: { kind: "child", name: "label" } });
  });
});
