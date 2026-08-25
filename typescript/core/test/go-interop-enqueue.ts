import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Pool } from "pg";

import { Queue } from "../src/queue.js";

const [databaseUrl, queueName] = process.argv.slice(2);
if (databaseUrl === undefined || queueName === undefined) {
  throw new Error("usage: go-interop-enqueue.ts <database-url> <queue-name>");
}

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const contextManager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(contextManager);
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(provider);

const pool = new Pool({ connectionString: databaseUrl });
try {
  const queue = new Queue(pool, queueName);
  const caller = trace.getTracer("workhorse-go-interoperability-test").startSpan("caller");
  const callerContext = trace.setSpan(context.active(), caller);
  const jobId = await context.with(callerContext, () =>
    queue.enqueue(
      "telemetry",
      { secret: "never log this" },
      { deadline: new Date(Date.now() + 60_000) },
    ),
  );
  caller.end();
  await provider.forceFlush();
  const enqueue = exporter.getFinishedSpans().find((span) => span.name === "workhorse.enqueue");
  if (enqueue === undefined) throw new Error("TypeScript enqueue span was not exported");
  process.stdout.write(
    JSON.stringify({
      jobId,
      traceId: enqueue.spanContext().traceId,
      spanId: enqueue.spanContext().spanId,
    }),
  );
} finally {
  await pool.end();
  await provider.shutdown();
  contextManager.disable();
  propagation.disable();
  trace.disable();
}
