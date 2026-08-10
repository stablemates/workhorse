import { describe, expect, it } from "vitest";
import {
  describeIdempotency,
  formatIdempotencyWindow,
  hasIdempotencyEvidence,
  idempotencyEventDetailKeys,
  idempotencyEvidenceLine,
  readIdempotencyEvidence,
  type IdempotencyEvidence,
} from "./model.js";

const rawKey = "order-9f3a-super-secret-caller-key";

const safeDetails = {
  state: "ready",
  run_at: "2026-08-01T00:00:00.000Z",
  idempotency: {
    scope: "workhorse-demo:orders",
    key_preview: "order-9f…",
    key_digest: "1f0c7f6d1a2b3c4d5e6f708192a3b4c5",
    key_length: rawKey.length,
    ttl_ms: 86_400_000,
    expires_at: "2026-08-02T00:00:00.000Z",
    request_digest: "abcdef0123456789abcdef0123456789",
  },
};

const evidence: IdempotencyEvidence = {
  scope: "workhorse-demo:orders",
  keyDigest: "1f0c7f6d1a2b3c4d5e6f708192a3b4c5",
  keyLength: rawKey.length,
  ttlMs: 86_400_000,
  expiresAt: "2026-08-02T00:00:00.000Z",
  requestDigest: "abcdef0123456789abcdef0123456789",
};

describe("idempotency evidence", () => {
  it("reads only the safe metadata recorded on the initial enqueued event", () => {
    expect(readIdempotencyEvidence({ type: "enqueued", details: safeDetails })).toEqual(evidence);
  });

  it("treats an unkeyed enqueue as carrying no deduplication surface at all", () => {
    expect(
      readIdempotencyEvidence({
        type: "enqueued",
        details: { state: "ready", run_at: "2026-08-01T00:00:00.000Z" },
      }),
    ).toBeNull();
    expect(readIdempotencyEvidence({ type: "enqueued", details: null })).toBeNull();
    expect(readIdempotencyEvidence({ type: "enqueued", details: "ready" })).toBeNull();
  });

  it("never derives evidence from any event other than the initial enqueued event", () => {
    for (const type of ["claimed", "checkpoint_saved", "retry_scheduled", "succeeded"]) {
      expect(readIdempotencyEvidence({ type, details: safeDetails })).toBeNull();
    }
  });

  it("refuses to render a partially recorded claim about deduplication", () => {
    for (const missing of ["scope", "key_digest", "key_length", "ttl_ms", "request_digest"]) {
      const partial: Record<string, unknown> = { ...safeDetails.idempotency };
      delete partial[missing];
      expect(
        readIdempotencyEvidence({ type: "enqueued", details: { idempotency: partial } }),
      ).toBeNull();
    }
  });

  it("still reads evidence when only the optional expiry is absent", () => {
    const withoutExpiry: Record<string, unknown> = { ...safeDetails.idempotency };
    delete withoutExpiry.expires_at;
    expect(
      readIdempotencyEvidence({ type: "enqueued", details: { idempotency: withoutExpiry } }),
    ).toMatchObject({ expiresAt: null, scope: "workhorse-demo:orders" });
  });

  it("rejects a non-object idempotency record instead of guessing", () => {
    for (const record of [null, "keyed", 7, ["scope"]]) {
      expect(
        readIdempotencyEvidence({ type: "enqueued", details: { idempotency: record } }),
      ).toBeNull();
    }
  });

  it("summarises a task's events without scanning anything but enqueued", () => {
    expect(
      hasIdempotencyEvidence([
        { type: "enqueued", details: { state: "ready" } },
        { type: "claimed", details: safeDetails },
      ]),
    ).toBe(false);
    expect(
      hasIdempotencyEvidence([
        { type: "enqueued", details: safeDetails },
        { type: "claimed", details: { worker_id: "demo-worker-1" } },
      ]),
    ).toBe(true);
  });

  it("never exposes a raw key through any rendered wording", () => {
    const described = describeIdempotency(evidence);
    const rendered = [
      described.label,
      described.summary,
      described.exact,
      idempotencyEvidenceLine(evidence),
    ].join(" ");
    expect(rendered).not.toContain(rawKey);
    expect(rendered).not.toContain("super-secret");
    expect(described.exact).toContain("The raw key is never stored on the event");
  });

  it("states the deduplication contract in words rather than stored field names", () => {
    const described = describeIdempotency(evidence);
    expect(described.label).toBe("Keyed");
    expect(described.summary).toBe(
      "If you repeat this request in workhorse-demo:orders within 24 hours, Workhorse returns this task again",
    );
    expect(described.exact).toContain(`key length ${rawKey.length} bytes`);
    expect(described.exact).toContain("retained for 86400000 ms");
    expect(described.exact).toContain("retained until 2026-08-02T00:00:00.000Z");
  });

  it("omits an absent expiry from the exact wording instead of inventing one", () => {
    expect(describeIdempotency({ ...evidence, expiresAt: null }).exact).not.toContain(
      "retained until",
    );
  });

  it("shortens digests in the compact line while keeping scope and key length intact", () => {
    expect(idempotencyEvidenceLine(evidence)).toBe(
      "scope workhorse-demo:orders · key length 34 · digest 1f0c7f6d1a2b · request abcdef012345",
    );
  });

  it("formats retention windows without inventing precision", () => {
    expect(formatIdempotencyWindow(86_400_000)).toBe("24 hours");
    expect(formatIdempotencyWindow(2 * 86_400_000)).toBe("2 days");
    expect(formatIdempotencyWindow(3_600_000)).toBe("1 hour");
    expect(formatIdempotencyWindow(6 * 3_600_000)).toBe("6 hours");
    expect(formatIdempotencyWindow(60_000)).toBe("1 minute");
    expect(formatIdempotencyWindow(90_000)).toBe("90000 ms");
    expect(formatIdempotencyWindow(1)).toBe("1 ms");
  });

  it("pins the safe detail keys the dashboard is allowed to read", () => {
    expect([...idempotencyEventDetailKeys]).toEqual([
      "scope",
      "key_digest",
      "key_length",
      "ttl_ms",
      "expires_at",
      "request_digest",
    ]);
    expect(idempotencyEventDetailKeys).not.toContain("key");
    // A prefix preview reproduces a short key whole, so it is not a safe surface either.
    expect(idempotencyEventDetailKeys).not.toContain("key_preview");
  });
});
