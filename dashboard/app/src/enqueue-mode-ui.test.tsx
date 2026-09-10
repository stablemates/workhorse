import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardJobDetail } from "./wire.js";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

const key = {
  scope: "billing",
  key_digest: "0123456789abcdef",
  key_length: 24,
  key_preview: "private-key-preview",
  key: "private-raw-key",
};
const idempotency = {
  ...key,
  ttl_ms: 60000,
  expires_at: "2026-09-10T12:01:00Z",
  request_digest: "abcdef0123456789",
};
const coalescing = { ...key, window_ms: 60000, expires_at: idempotency.expires_at };
const event = (
  type: string,
  details: unknown,
  second = 0,
): DashboardJobDetail["events"][number] => ({
  id: `${type}-${second}`,
  type,
  details,
  attempt: null,
  occurredAt: `2026-09-10T12:00:${String(second).padStart(2, "0")}Z`,
});

async function render(events: DashboardJobDetail["events"]) {
  const { TaskEnqueueSection } = await import("./components/task-detail-relations.js");
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(TaskEnqueueSection, { job: { events } as DashboardJobDetail }),
    ),
  );
}

describe("task enqueue mode", () => {
  it.each(["debounce", "throttle"] as const)(
    "shows only %s despite shared idempotency metadata",
    async (mode) => {
      const html = await render([
        event("enqueued", {
          idempotency,
          [mode]: { ...coalescing, ...(mode === "debounce" ? { schedule: "reset" } : {}) },
        }),
      ]);
      expect(html).toContain(mode === "debounce" ? ">Debounce<" : ">Throttle<");
      expect(html).not.toContain("idempotency-heading");
      expect(html).toContain(idempotency.request_digest);
      expect(html).toContain(key.key_digest);
      expect(html).not.toContain(key.key);
      expect(html).not.toContain(key.key_preview);
    },
  );

  it("keeps an idempotent task idempotent after a rejected debounce proposal", async () => {
    const html = await render([
      event("enqueued", { idempotency }),
      event("debounce_rejected", { reason: "incompatible_key_mode", debounce: coalescing }, 10),
    ]);
    expect(html).toContain("idempotency-heading");
    expect(html).not.toContain("coalescing-heading");
    expect(html).toContain("Workhorse returns this task again");
  });

  it("uses the last accepted debounce window and ignores newer rejected settings", async () => {
    const { coalescingEvidenceFor } = await import("./components/task-detail-overview.js");
    const accepted = {
      ...coalescing,
      schedule: "preserve",
      window_ms: 90000,
      expires_at: "2026-09-10T12:02:00Z",
    };
    const events = [
      event(
        "debounce_rejected",
        { debounce: { ...coalescing, window_ms: 1 }, reason: "not_pending" },
        30,
      ),
      event("debounced", { debounce: accepted }, 20),
      event("enqueued", { idempotency, debounce: { ...coalescing, schedule: "reset" } }),
    ];
    expect(coalescingEvidenceFor({ events } as DashboardJobDetail)).toMatchObject({
      windowMs: 90000,
      schedule: "preserve",
      expiresAt: accepted.expires_at,
      absorbed: 1,
      rejected: 1,
    });
    expect(await render(events)).toContain("Keep the original run time");
  });

  it("keeps the original throttle window even when a later submission asks for another duration", async () => {
    const { coalescingEvidenceFor } = await import("./components/task-detail-overview.js");
    const events = [
      event("throttled", { throttle: { ...coalescing, window_ms: 90000 } }, 20),
      event("enqueued", { idempotency, throttle: coalescing }),
      event("debounce_rejected", { debounce: coalescing, reason: "incompatible_key_mode" }, 30),
    ];
    expect(coalescingEvidenceFor({ events } as DashboardJobDetail)).toMatchObject({
      mode: "throttle",
      windowMs: 60000,
      absorbed: 1,
      rejected: 0,
    });
    expect(await render(events)).toContain(">Throttle<");
  });

  it("does not invent an accepted mode from a rejection or an unkeyed task", async () => {
    for (const events of [
      [],
      [event("enqueued", {})],
      [event("debounce_rejected", { debounce: coalescing })],
    ]) {
      const html = await render(events);
      expect(html).not.toContain("coalescing-heading");
      expect(html).not.toContain("idempotency-heading");
    }
  });
});

describe("task listing enqueue labels", () => {
  it.each([
    ["idempotency", "Idempotency"],
    ["debounce", "Debounce"],
    ["throttle", "Throttle"],
  ] as const)("labels %s explicitly", async (enqueueMode, label) => {
    const { TaskEnqueueBadge } = await import("./components/task-list.js");
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(TaskEnqueueBadge, { job: { keyed: true, enqueueMode } }),
      ),
    );
    expect(html).toContain(`>${label}<`);
    expect(html).not.toContain(">Keyed<");
    expect(html).toContain("title=");
  });
  it("keeps the legacy keyed fallback and omits unkeyed labels", async () => {
    const { TaskEnqueueBadge } = await import("./components/task-list.js");
    const renderBadge = (keyed: boolean) =>
      renderToStaticMarkup(
        createElement(MantineProvider, null, createElement(TaskEnqueueBadge, { job: { keyed } })),
      );
    expect(renderBadge(true)).toContain(">Keyed<");
    expect(renderBadge(false)).not.toContain("mantine-Badge-root");
  });
});
