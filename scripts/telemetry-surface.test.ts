import { describe, expect, it } from "vitest";

import { telemetrySurface } from "./telemetry-surface.js";

/**
 * The telemetry reader against the source it reads.
 *
 * The reader recognizes four syntactic shapes, and the failure that matters is a silent one: a
 * refactor moves an instrument out of the shape the reader knows, the name leaves
 * `api/telemetry.txt`, and the check reports it as a deliberate removal. The generator already
 * refuses to write an empty file, so what is left to hold is that each shape still yields what only
 * it can yield. One name per shape does that, and each is one a dashboard would query.
 */

const surface = await telemetrySurface();

describe("the telemetry surface reader", () => {
  it("reads a counter's unit and description from its helper call", () => {
    expect(surface.instruments).toContainEqual({
      name: "workhorse.jobs.enqueued",
      kind: "counter",
      unit: "{job}",
      description: "Jobs accepted for durable execution",
    });
  });

  it("reads a histogram", () => {
    expect(surface.instruments).toContainEqual({
      name: "workhorse.handler.duration",
      kind: "histogram",
      unit: "ms",
      description: "Handler execution latency",
    });
  });

  it("reads a gauge", () => {
    expect(surface.instruments).toContainEqual({
      name: "workhorse.jobs.count",
      kind: "gauge",
      unit: "{job}",
      description: "Current live jobs by queue and runtime state",
    });
  });

  it("reads an asynchronous observation from its definition array", () => {
    expect(surface.instruments).toContainEqual({
      name: "workhorse.queue.depth",
      kind: "observable_gauge",
      unit: "{job}",
      description: "Current live work by dispatch state",
    });
  });

  it("reads span names from the calls that open them", () => {
    expect(surface.spans).toContain("workhorse.claim");
    expect(surface.spans).toContain("workhorse.handler");
  });

  it("reads attributes from property position and from setAttribute", () => {
    expect(surface.attributes).toContain("workhorse.queue.name");
    expect(surface.attributes).toContain("workhorse.retry.outcome");
  });

  it("keeps span and log event names out of the attribute list", () => {
    // Property position is the whole rule that separates an attribute from every other
    // `workhorse.`-prefixed string, and a span name and a log event name are both arguments.
    // An instrument name is not tested here: `workhorse.handler.batch.size` is a histogram and
    // also an attribute of the batch span, and both readings are right.
    for (const span of surface.spans) expect(surface.attributes).not.toContain(span);
    expect(surface.attributes).not.toContain("workhorse.job.claimed");
    expect(surface.attributes).not.toContain("workhorse.worker.registered");
  });
});
