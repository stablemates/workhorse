import { isDemoOperatorMutation } from "./operator-rate-limit.js";

/**
 * Largest request body the public demo reads.
 *
 * The widest legitimate input is a signal or human-decision value, which the queue contract
 * bounds at 64 KiB before JSON encoding and envelope overhead. The cap leaves headroom above
 * that contract while keeping a hostile body cheap to refuse.
 */
export const DEMO_REQUEST_BODY_MAX_BYTES = 131_072;

/**
 * How long one request may occupy the server, including a slowly delivered body.
 *
 * The body cap bounds size, not speed; without a whole-request deadline a client could hold a
 * connection open for as long as it trickles bytes. Sixty seconds is far past what any
 * dashboard read or mutation takes.
 */
export const DEMO_REQUEST_TIMEOUT_MS = 60_000;

/**
 * How many operator mutations may execute at once.
 *
 * Every mutation holds a pooled connection across an audited transaction. An unbounded wave of
 * admitted requests — many clients can each be inside their own rate-limit burst — could occupy
 * every connection the dashboard's reads need, so admissions past the cap are refused outright.
 */
export const DEMO_OPERATOR_MAX_CONCURRENT_MUTATIONS = 4;

const BODY_BEARING_METHODS = new Set(["POST", "PUT", "PATCH"]);

export interface DemoGuardedRequest {
  headers: {
    [name: string]: string | string[] | undefined;
    "content-length"?: string | string[] | undefined;
    "transfer-encoding"?: string | string[] | undefined;
  };
  method?: string | undefined;
  url?: string | undefined;
}

/**
 * Reject a request whose declared body exceeds the cap, or a body-bearing method that streams an
 * undeclared length.
 *
 * The server's HTTP parser has already refused a malformed or conflicting `Content-Length` by
 * the time this runs, so the header is absent, one integer, or a repeat of one integer. A
 * body-bearing method with no framing header carries no body by definition and passes.
 */
export function demoRequestBodyRejection(request: DemoGuardedRequest): 411 | 413 | undefined {
  const header = request.headers["content-length"];
  const declared = Array.isArray(header) ? Math.max(...header.map(Number)) : Number(header);
  if (declared > DEMO_REQUEST_BODY_MAX_BYTES) return 413;
  if (
    BODY_BEARING_METHODS.has(request.method ?? "") &&
    header === undefined &&
    request.headers["transfer-encoding"] !== undefined
  ) {
    return 411;
  }
  return undefined;
}

/** A process-local cap on operator mutations executing at the same time. */
export class DemoOperatorMutationGuard {
  #active = 0;

  /** Take a slot when the request is an operator mutation; every other request always passes. */
  tryAcquire(request: Pick<DemoGuardedRequest, "method" | "url">): boolean {
    if (!isDemoOperatorMutation(request)) return true;
    if (this.#active >= DEMO_OPERATOR_MAX_CONCURRENT_MUTATIONS) return false;
    this.#active += 1;
    return true;
  }

  /** Return the slot a request held. Safe to pair with every `tryAcquire` that returned true. */
  release(request: Pick<DemoGuardedRequest, "method" | "url">): void {
    if (isDemoOperatorMutation(request)) this.#active = Math.max(0, this.#active - 1);
  }
}
