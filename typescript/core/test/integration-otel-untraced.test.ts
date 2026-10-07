import { context as otelContext, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { suppressTracing, W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { registerOpenTelemetry } from "@stablemates/workhorse-otel";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Worker } from "../src/worker.js";
import { createIntegrationTestContext } from "./support/integration.js";

registerOpenTelemetry();

const { pool, queue, admin, adminAudit } = createIntegrationTestContext(import.meta.url);
const contextManager = new AsyncLocalStorageContextManager();
const spanExporter = new InMemorySpanExporter();

const unrelatedTraceId = "0af7651916cd43dd8448eb211c80319c";
const unrelatedSpanId = "b7ad6b7169203331";

beforeAll(() => {
  otelContext.setGlobalContextManager(contextManager.enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] }),
  );
});

beforeEach(() => spanExporter.reset());

afterAll(() => {
  otelContext.disable();
  contextManager.disable();
  propagation.disable();
  trace.disable();
});

/** Runs `operation` inside a span that has nothing to do with any task. */
const underUnrelatedSpan = <T>(operation: () => Promise<T>) =>
  otelContext.with(
    trace.setSpanContext(otelContext.active(), {
      traceId: unrelatedTraceId,
      spanId: unrelatedSpanId,
      traceFlags: 1,
    }),
    operation,
  );

/** Enqueues with tracing suppressed, so PostgreSQL stores no trace context for the task. */
const enqueueUntraced = <T>(operation: () => Promise<T>) =>
  otelContext.with(suppressTracing(otelContext.active()), operation);

function handlerSpans(): ReadableSpan[] {
  return spanExporter.getFinishedSpans().filter((span) => span.name === "workhorse.handler");
}

async function storedTraceContexts(ids: readonly string[]): Promise<unknown[]> {
  const result = await pool.query<{ trace_context: unknown }>(
    "SELECT trace_context FROM workhorse.task WHERE id = ANY($1::uuid[])",
    [ids],
  );
  return result.rows.map((row) => row.trace_context);
}

describe("an untraced task", () => {
  it("starts a new trace instead of joining a span active in the worker", async () => {
    const untracedId = await enqueueUntraced(() =>
      queue.enqueue("untraced.ambient", null, { queue: "untraced-ambient" }),
    );
    const tracedId = await queue.enqueue("untraced.ambient", null, { queue: "untraced-ambient" });
    expect(await storedTraceContexts([untracedId])).toEqual([null]);
    const enqueueSpan = spanExporter
      .getFinishedSpans()
      .find((span) => span.name === "workhorse.enqueue");
    expect(enqueueSpan).toBeDefined();
    const ran: string[] = [];
    const worker = new Worker(queue, {
      workerId: "untraced-ambient",
      queue: "untraced-ambient",
    }).handle("untraced.ambient", async (_payload, context) => {
      ran.push(context.task.id);
      return null;
    });

    await underUnrelatedSpan(async () => {
      expect(await worker.runOnce()).toBe(true);
      expect(await worker.runOnce()).toBe(true);
    });

    expect(ran).toEqual([untracedId, tracedId]);
    const [untraced, traced] = handlerSpans();
    expect(untraced?.parentSpanContext).toBeUndefined();
    expect(untraced?.spanContext().traceId).not.toBe(unrelatedTraceId);
    // A stored context still parents its handler span, whatever span the worker runs under.
    expect(traced?.parentSpanContext?.spanId).toBe(enqueueSpan?.spanContext().spanId);
    expect(traced?.spanContext().traceId).toBe(enqueueSpan?.spanContext().traceId);
  });

  it("starts a new trace when a fused completion claims it", async () => {
    await expect(
      admin.setQueueTier("untraced-fused", "fast", adminAudit("move to the fast tier")),
    ).resolves.toBe("fast");
    const taskIds = await enqueueUntraced(() =>
      queue.enqueueMany(
        Array.from({ length: 12 }, (_, sequence) => ({
          type: "untraced.fused",
          payload: { sequence },
          options: { queue: "untraced-fused" },
        })),
      ),
    );
    expect(await storedTraceContexts(taskIds)).toEqual(taskIds.map(() => null));
    const claimFast = vi.spyOn(queue, "claimFast");
    const completed = new Set<string>();
    const worker = new Worker(queue, {
      workerId: "untraced-fused",
      queue: "untraced-fused",
      concurrency: 2,
      pollMs: 5,
    }).handle("untraced.fused", async (_payload, context) => {
      completed.add(context.task.id);
      return null;
    });

    const controller = new AbortController();
    const run = worker.run(controller.signal);
    try {
      await vi.waitFor(() => expect(completed.size).toBe(taskIds.length), {
        timeout: 20_000,
        interval: 20,
      });
    } finally {
      controller.abort();
      worker.stop();
      await run;
    }

    // Completions claimed most tasks, so most handlers started inside another task's spans.
    const plainClaims = await Promise.all(
      claimFast.mock.results.map((result) => result.value as Promise<unknown[]>),
    );
    claimFast.mockRestore();
    expect(plainClaims.reduce((sum, claimed) => sum + claimed.length, 0)).toBeLessThan(
      taskIds.length,
    );
    const spans = handlerSpans();
    expect(spans).toHaveLength(taskIds.length);
    for (const span of spans) expect(span.parentSpanContext).toBeUndefined();
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(taskIds.length);
  });
});
