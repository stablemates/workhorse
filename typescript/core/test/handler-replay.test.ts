import { describe, expect, it, vi } from "vitest";
import { HandlerReplayError, replayHandler, type DurableState } from "../src/index.js";
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
