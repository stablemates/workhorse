import { describe, expect, it } from "vitest";
import { IngressError, MAX_BODY_BYTES, verifyInvoice } from "../../examples/stripe-invoice-paid.js";
import { invoiceEvent, signedFixture, stripeScope } from "./support/stripe-invoice-fixture.js";

describe("Stripe raw-byte signing and normalization", () => {
  it("verifies the official SDK's realistic signed snapshot without storing invoice contents", () => {
    const { body, signature } = signedFixture();
    expect(verifyInvoice(body, signature, stripeScope)).toEqual({
      accountId: "acct_fixture",
      livemode: false,
      eventId: "evt_fixture",
      eventCreated: 1_790_966_400,
      invoiceId: "in_fixture",
      customerId: "cus_fixture",
    });
  });

  it("verifies untouched whitespace and rejects even a whitespace-only body transformation", () => {
    const payload = JSON.stringify(invoiceEvent(), null, 2);
    const { body, signature } = signedFixture(undefined, { payload });
    expect(verifyInvoice(body, signature, stripeScope)?.invoiceId).toBe("in_fixture");
    expect(() =>
      verifyInvoice(Buffer.from(JSON.stringify(invoiceEvent())), signature, stripeScope),
    ).toThrow("Invalid or stale signature");
  });

  it.each([
    ["bad secret", { secret: "whsec_wrong" }],
    ["stale timestamp", { timestamp: Math.floor(Date.now() / 1_000) - 301 }],
  ])("rejects %s", (_name, options) => {
    const { body, signature } = signedFixture(invoiceEvent(), options);
    expect(() => verifyInvoice(body, signature, stripeScope)).toThrow(IngressError);
  });

  it("accepts overlapping endpoint-secret rotation without weakening timestamp verification", () => {
    const { body, signature } = signedFixture();
    expect(
      verifyInvoice(body, signature, {
        ...stripeScope,
        signingSecrets: ["whsec_new", ...stripeScope.signingSecrets],
      })?.eventId,
    ).toBe("evt_fixture");
  });

  it.each([{ account: "acct_other" }, { account: undefined }, { livemode: true }])(
    "rejects authenticated but unauthorized scope %j",
    (overrides) => {
      const { body, signature } = signedFixture(invoiceEvent(overrides));
      expect(() => verifyInvoice(body, signature, stripeScope)).toThrow(
        "Unauthorized Stripe scope",
      );
    },
  );

  it.each([
    { api_version: "2025-09-30.clover" },
    { object: "v2.core.event" },
    { id: "evt_../../private" },
    { created: 1.5 },
  ])("rejects unsupported signed snapshot %j", (overrides) => {
    const { body, signature } = signedFixture(invoiceEvent(overrides));
    expect(() => verifyInvoice(body, signature, stripeScope)).toThrow(IngressError);
  });

  it.each([
    { status: "open" },
    { customer: null },
    { customer: { id: "cus_fixture" } },
    { livemode: true },
  ])("rejects unsupported invoice %j", (overrides) => {
    const { body, signature } = signedFixture(invoiceEvent({}, overrides));
    expect(() => verifyInvoice(body, signature, stripeScope)).toThrow(IngressError);
  });

  it("ignores unrelated authenticated events without needing their object or ordering", () => {
    const { body, signature } = signedFixture(invoiceEvent({ type: "invoice.created", data: {} }));
    expect(verifyInvoice(body, signature, stripeScope)).toBeNull();
  });

  it("accepts an exactly bounded signed body without persisting its padding", () => {
    const serialized = JSON.stringify(invoiceEvent());
    const payload = serialized + " ".repeat(MAX_BODY_BYTES - Buffer.byteLength(serialized));
    const fixture = signedFixture(undefined, { payload });
    expect(verifyInvoice(fixture.body, fixture.signature, stripeScope)?.invoiceId).toBe(
      "in_fixture",
    );
  });

  it("bounds bytes before SDK parsing", () => {
    expect(() => verifyInvoice(Buffer.alloc(MAX_BODY_BYTES + 1), "invalid", stripeScope)).toThrow(
      "Payload too large",
    );
  });
});
