import { Stripe } from "stripe";
import { STRIPE_API_VERSION, type StripeScope } from "../../../examples/stripe-invoice-paid.js";

const signingSecret = "whsec_local_fixture_only";
export const stripeScope: StripeScope = {
  accountId: "acct_fixture",
  livemode: false,
  signingSecrets: [signingSecret],
};

const signingSdk = new Stripe("sk_test_offline_fixture_only", { apiVersion: STRIPE_API_VERSION });

export function invoiceEvent(
  eventOverrides: Record<string, unknown> = {},
  invoiceOverrides: Record<string, unknown> = {},
) {
  return {
    id: "evt_fixture",
    object: "event",
    account: stripeScope.accountId,
    api_version: STRIPE_API_VERSION,
    created: 1_790_966_400,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "invoice.paid",
    data: {
      object: {
        id: "in_fixture",
        object: "invoice",
        customer: "cus_fixture",
        livemode: false,
        status: "paid",
        amount_paid: 2_000,
        amount_due: 2_000,
        currency: "usd",
        customer_email: "never-persist@example.invalid",
        customer_name: "Private invoice customer",
        hosted_invoice_url: "https://invoice.stripe.com/i/sensitive-fixture-only",
        metadata: { sensitive: "do not store or log" },
        lines: { object: "list", data: [], has_more: false, url: "/v1/invoices/in_fixture/lines" },
        status_transitions: { paid_at: 1_790_966_400 },
        ...invoiceOverrides,
      },
    },
    ...eventOverrides,
  };
}

export function signedFixture(
  event: unknown = invoiceEvent(),
  options: { timestamp?: number; secret?: string; payload?: string } = {},
) {
  const payload = options.payload ?? JSON.stringify(event);
  const signature = signingSdk.webhooks.generateTestHeaderString({
    payload,
    secret: options.secret ?? signingSecret,
    timestamp: options.timestamp ?? Math.floor(Date.now() / 1_000),
  });
  return { body: Buffer.from(payload), signature };
}
