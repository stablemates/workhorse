import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { Http2Bindings, HttpBindings } from "@hono/node-server";
import type { DemoOperatorRateLimiter } from "./operator-rate-limit.js";
import {
  DEMO_REQUEST_TIMEOUT_MS,
  type DemoOperatorMutationGuard,
  demoRequestBodyRejection,
} from "./request-guards.js";

type DemoFetch = (
  request: Request,
  env: HttpBindings | Http2Bindings,
) => Response | Promise<Response>;

type DemoMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void;

export interface DemoRequestListenerOptions {
  /** The application that answers every request the guards admit. */
  fetch: DemoFetch;
  /** Development middleware that may answer a request before the application sees it. */
  dev?: DemoMiddleware | undefined;
  rateLimiter: Pick<DemoOperatorRateLimiter, "check">;
  mutationGuard: Pick<DemoOperatorMutationGuard, "tryAcquire" | "release">;
  /** How long the application may take to answer once it starts handling a request. */
  handlerTimeoutMs?: number;
}

interface Admission {
  started: boolean;
  release: () => void;
}

/**
 * Build the demo's HTTP listener: refuse oversized bodies, rate-limit and cap operator mutations,
 * then hand the request to the application.
 *
 * A mutation slot returns when the application's answer settles, not when the response closes.
 * A client that disconnects mid-mutation closes its response at once, while the mutation's
 * transaction still holds a pooled connection; returning the slot on close would let a wave of
 * abandoned requests occupy every connection the cap exists to protect.
 *
 * The application has `handlerTimeoutMs` to answer. Past it the client receives 504 and the
 * connection is free, while the slot stays held until the application's work settles.
 */
export function createDemoRequestListener(
  options: DemoRequestListenerOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  const handlerTimeoutMs = options.handlerTimeoutMs ?? DEMO_REQUEST_TIMEOUT_MS;
  const admissions = new WeakMap<IncomingMessage, Admission>();

  const application = getRequestListener((request, env) => {
    // The demo serves HTTP/1.1, so the adapter hands back the same request object it received.
    const admission = admissions.get(env.incoming as IncomingMessage);
    if (admission) admission.started = true;
    let answer: Promise<Response>;
    try {
      answer = Promise.resolve(options.fetch(request, env));
    } catch (error) {
      admission?.release();
      throw error;
    }
    answer.then(admission?.release, admission?.release);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<Response>((resolve) => {
      timer = setTimeout(() => resolve(timedOut()), handlerTimeoutMs);
    });
    return Promise.race([answer, deadline]).finally(() => clearTimeout(timer));
  });

  return (request, response) => {
    const reject = (status: number, message: string, retryAfterSeconds?: number) => {
      response.statusCode = status;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=UTF-8");
      if (retryAfterSeconds !== undefined) {
        response.setHeader("Retry-After", String(retryAfterSeconds));
      }
      response.end(JSON.stringify({ message }));
    };
    const bodyRejection = demoRequestBodyRejection(request);
    if (bodyRejection !== undefined) {
      reject(
        bodyRejection,
        bodyRejection === 413 ? "Request body too large" : "A Content-Length header is required",
      );
      return;
    }
    const retryAfterSeconds = options.rateLimiter.check(request);
    if (retryAfterSeconds !== undefined) {
      reject(429, "Operator request rate limit exceeded", retryAfterSeconds);
      return;
    }
    if (!options.mutationGuard.tryAcquire(request)) {
      reject(503, "Too many concurrent operator mutations", 1);
      return;
    }
    let released = false;
    const admission: Admission = {
      started: false,
      release: () => {
        if (released) return;
        released = true;
        options.mutationGuard.release(request);
      },
    };
    admissions.set(request, admission);
    // A request the application never handled — answered by development middleware, refused by
    // the adapter, or abandoned before either — has no work to wait for once its response closes.
    response.once("close", () => {
      if (!admission.started) admission.release();
    });
    const next = (error?: unknown) => {
      if (error) {
        response.statusCode = 500;
        response.end("Internal Server Error");
        return;
      }
      // A client that left while development middleware held its request already returned the
      // slot. Running the mutation now would hold a pooled connection the cap no longer counts.
      if (released) return;
      void application(request, response);
    };
    if (options.dev) options.dev(request, response, next);
    else next();
  };
}

function timedOut(): Response {
  return new Response(JSON.stringify({ message: "Request timed out" }), {
    status: 504,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=UTF-8",
    },
  });
}
