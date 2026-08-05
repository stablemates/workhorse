import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { DashboardHost } from "./host.js";

/** Minimal Connect-style middleware signature shared by Express, Connect, and Fastify's middie. */
export type DashboardNodeMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void;

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

function requestUrl(request: IncomingMessage): string {
  const host = request.headers.host ?? "localhost";
  const encrypted = "encrypted" in request.socket && Boolean(request.socket.encrypted);
  const forwarded = request.headers["x-forwarded-proto"];
  const protocol =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() ??
    (encrypted ? "https" : "http");
  return new URL(request.url ?? "/", `${protocol}://${host}`).toString();
}

function fetchRequest(request: IncomingMessage): Request {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  request.once("close", () => controller.abort());

  const method = request.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
    else headers.set(name, value);
  }

  const init: RequestInit & { duplex?: "half" } = { method, headers, signal: controller.signal };
  if (!BODYLESS_METHODS.has(method.toUpperCase())) {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(requestUrl(request), init);
}

async function writeResponse(result: Response, response: ServerResponse): Promise<void> {
  for (const [name, value] of result.headers) {
    if (name.toLowerCase() === "set-cookie") continue;
    response.setHeader(name, value);
  }
  const cookies = result.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);

  response.writeHead(result.status);
  // Server-sent events must reach the client as they are produced, never buffered to completion.
  response.flushHeaders?.();

  if (!result.body) {
    response.end();
    return;
  }
  const body = Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0]);
  response.once("close", () => body.destroy());
  await new Promise<void>((resolve, reject) => {
    body.pipe(response);
    body.once("error", reject);
    response.once("finish", () => resolve());
    response.once("close", () => resolve());
  });
}

/**
 * Adapt a framework-neutral dashboard host to Connect-style Node middleware.
 *
 * This is the integration path for Express, Connect, and Fastify (via `@fastify/middie`). Hosts
 * built on the Fetch API — Hono, Next.js route handlers, SvelteKit, Nitro — should call
 * `host.handle(request)` directly instead, and fall through when it resolves to `null`.
 *
 * Requests the host does not own are passed to `next()` untouched, so the dashboard never takes
 * over unrelated application routes.
 */
export function dashboardNodeMiddleware(host: DashboardHost): DashboardNodeMiddleware {
  return (request, response, next) => {
    let fetchRequestValue: Request;
    try {
      fetchRequestValue = fetchRequest(request);
    } catch (error) {
      next(error);
      return;
    }
    if (!host.owns(fetchRequestValue)) {
      next();
      return;
    }

    void (async () => {
      try {
        const result = await host.handle(fetchRequestValue);
        if (!result) {
          next();
          return;
        }
        await writeResponse(result, response);
      } catch (error) {
        next(error);
      }
    })();
  };
}
