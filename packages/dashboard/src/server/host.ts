import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { RPCHandler } from "@orpc/server/fetch";
import { assertSchemaCompatible, Queue, type Queryable } from "@workhorse/core";
import type { MaintenanceLoopCadences } from "../model.js";
import { dashboardAssetsDirectory } from "./assets.js";
import { renderDashboardHtml } from "./html.js";
import { DashboardRefreshHub, type DashboardRefreshEvent } from "./refresh.js";
import { dashboardRouter } from "./router.js";
import { dashboardDatabase } from "./sql.js";
import type {
  DashboardDurabilityProjector,
  DashboardOperator,
  DashboardQueueController,
  DashboardScheduleController,
  DashboardTaskController,
  DashboardWorkerController,
} from "./types.js";

export interface DashboardHostOptions {
  /**
   * Any Workhorse-compatible connection. The host never installs or migrates schema.
   *
   * The dashboard is a guest in the caller's process and deliberately does not accept a connection
   * string: it must not own pool sizing, shutdown ordering, reconnection, or TLS for an application
   * that already has a connection. Accepting a `Queryable` also keeps the package driver-agnostic
   * and free of a `pg` dependency, and works for deployments that have no URL at all, such as IAM
   * token auth, unix sockets, or dynamically issued credentials.
   */
  database: Queryable;
  /** URL mount path. Defaults to `/workhorse`; use `/` to own the host root. */
  path?: string;
  environment?: string;
  configuredWorkers?: readonly string[];
  maintenanceLoops?: MaintenanceLoopCadences;
  operator?: DashboardOperator;
  scheduleController?: DashboardScheduleController;
  queueController?: DashboardQueueController;
  taskController?: DashboardTaskController;
  workerController?: DashboardWorkerController;
  projectDurability?: DashboardDurabilityProjector;
  refresh?: DashboardRefreshHub;
  auditActor?: string;
  /** Trusted host-owned ES modules loaded before the dashboard browser entry. */
  browserModules?: readonly string[];
  /**
   * Serve the browser entry from source instead of the packaged bundle.
   *
   * Supply `createDashboardDevServer()` from `@workhorse/dashboard/dev` in development. The HTML
   * still goes through this host and the same `renderDashboardHtml` contract; only the module
   * source changes, which is what makes one origin able to hot-reload without a second server.
   */
  dev?: {
    readTemplate(): Promise<string>;
    transformHtml(url: string, html: string): Promise<string>;
  };
  /** Must explicitly authorize every dashboard, RPC, asset, and event-stream request. */
  authorize(request: Request): boolean | Response | Promise<boolean | Response>;
}

export interface DashboardHost {
  /** Normalized mount path. Empty string when the dashboard owns the host root. */
  readonly basePath: string;
  readonly refresh: DashboardRefreshHub;
  /** True when this request belongs to the dashboard's mount path. */
  owns(request: Request): boolean;
  /** Handle one request, or return null when the path is not owned by the dashboard. */
  handle(request: Request): Promise<Response | null>;
}

/** Normalize a caller-supplied mount path. `/` and `""` both mean "own the host root". */
export function normalizeDashboardPath(input: string): string {
  const path = `/${input}`.replaceAll(/\/+/g, "/").replace(/\/$/, "");
  return path === "/" ? "" : path;
}

const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const SSE_FALLBACK_INTERVAL_MS = 15_000;

function serverSentEvent(event: DashboardRefreshEvent): string {
  return `event: refresh\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Build a framework-neutral Workhorse dashboard request handler.
 *
 * The returned host serves the packaged React application, its private oRPC endpoint, the SSE
 * refresh stream, and static assets over standard `Request`/`Response` objects. It deliberately
 * never installs or migrates schema; it only asserts that the installed schema is compatible.
 *
 * Framework integration packages are expected to be thin: route every request under `basePath`
 * into `handle`, and fall through to their own routing when it resolves to `null`.
 */
export function createDashboardHost(options: DashboardHostOptions): DashboardHost {
  const path = normalizeDashboardPath(options.path ?? "/workhorse");
  const assets = dashboardAssetsDirectory();
  const refresh = options.refresh ?? new DashboardRefreshHub();
  const rpc = new RPCHandler(dashboardRouter);
  const database = dashboardDatabase(options.database);
  // The read model needs a Queue only for `health()`, which reads through the same connection and
  // does not depend on a default queue name, so there is nothing for a caller to supply here.
  const queue = new Queue(options.database);
  let compatibility: Promise<void> | undefined;

  const owns = (pathname: string): boolean =>
    path === "" || pathname === path || pathname.startsWith(`${path}/`);

  async function serveApplication(url: URL): Promise<Response> {
    const template = options.dev
      ? await options.dev.readTemplate()
      : await readFile(join(assets, "index.html"), "utf8");
    const rendered = renderDashboardHtml(template, {
      runtime: {
        basePath: path,
        rpcUrl: `${path}/rpc`,
        auditActor: options.auditActor ?? "dashboard",
        demoTools: Boolean(options.operator?.enqueueTest),
      },
      browserModules: options.browserModules,
    });
    const html = options.dev ? await options.dev.transformHtml(url.pathname, rendered) : rendered;
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  async function serveAsset(pathname: string): Promise<Response | null> {
    const relative = pathname.slice(`${path}/`.length);
    const safe = normalize(relative).replaceAll("\\", "/");
    if (!safe.startsWith("assets/") || safe.includes("../")) return null;
    try {
      const body = await readFile(join(assets, safe));
      return new Response(body, {
        headers: {
          "content-type": contentTypes[extname(safe)] ?? "application/octet-stream",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return null;
    }
  }

  function serveEvents(request: Request): Response {
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    let fallback: ReturnType<typeof setInterval> | undefined;
    let onAbort: (() => void) | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const publish = (event: DashboardRefreshEvent) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(serverSentEvent(event)));
          } catch {
            closed = true;
          }
        };
        const finish = () => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          if (fallback) clearInterval(fallback);
          if (onAbort) request.signal.removeEventListener("abort", onAbort);
          try {
            controller.close();
          } catch {
            // The stream was already torn down by the host framework.
          }
        };

        unsubscribe = refresh.subscribe(publish);
        fallback = setInterval(
          () => publish({ reason: "fallback", occurredAt: new Date().toISOString() }),
          SSE_FALLBACK_INTERVAL_MS,
        );
        fallback.unref?.();
        publish({ reason: "connected", occurredAt: new Date().toISOString() });

        onAbort = finish;
        if (request.signal.aborted) finish();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      },
      cancel() {
        unsubscribe?.();
        if (fallback) clearInterval(fallback);
        if (onAbort) request.signal.removeEventListener("abort", onAbort);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  return {
    basePath: path,
    refresh,
    owns(request) {
      return owns(new URL(request.url).pathname);
    },
    async handle(request) {
      const url = new URL(request.url);
      const pathname = url.pathname;
      if (!owns(pathname)) return null;

      const authorization = await options.authorize(request);
      if (authorization instanceof Response) return authorization;
      if (!authorization) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }

      compatibility ??= assertSchemaCompatible(options.database);
      try {
        await compatibility;
      } catch (error) {
        compatibility = undefined;
        return Response.json(
          { error: error instanceof Error ? error.message : "Incompatible Workhorse schema" },
          { status: 503 },
        );
      }

      if (pathname === `${path}/rpc` || pathname.startsWith(`${path}/rpc/`)) {
        const { response } = await rpc.handle(request, {
          prefix: `${path}/rpc` as `/${string}`,
          context: {
            database,
            queue,
            configuredWorkers: options.configuredWorkers ?? [],
            environment: options.environment ?? "unknown",
            maintenanceLoops: options.maintenanceLoops ?? { tickIntervalMs: 1_000 },
            operator: options.operator ?? { mode: "read-only" },
            scheduleController: options.scheduleController,
            queueController: options.queueController,
            taskController: options.taskController,
            workerController: options.workerController,
            projectDurability: options.projectDurability,
          },
        });
        return response ?? null;
      }

      if (pathname === `${path}/events`) return serveEvents(request);

      if (pathname.startsWith(`${path}/assets/`)) return serveAsset(pathname);

      if (pathname === (path || "/")) {
        // A relative Location keeps the redirect correct behind proxies that rewrite the host or
        // terminate TLS, which an absolute URL built from the inbound request would not.
        return new Response(null, { status: 302, headers: { location: `${path}/tasks` } });
      }

      return serveApplication(url);
    },
  };
}
