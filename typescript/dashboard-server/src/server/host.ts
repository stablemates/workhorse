import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { SeverityNumber, logs } from "@opentelemetry/api-logs";
import { RPCHandler } from "@orpc/server/fetch";
import type { DashboardSingleAdminOptions } from "@workhorse/dashboard-contract";
import { assertSchemaCompatible, Queue, type Queryable } from "@workhorse/core";
import type { MaintenanceLoopCadences } from "../wire.js";
import { dashboardAssetsDirectory } from "./assets.js";
import { createSingleAdminAuthentication } from "./authentication.js";
import { renderDashboardHtml } from "./html.js";
import { dashboardRouter, isDashboardMutation } from "./router.js";
import { dashboardDatabase } from "./sql.js";
import type {
  DashboardDurabilityProjector,
  DashboardOperator,
  DashboardQueueController,
  DashboardScheduleController,
  DashboardTaskController,
  DashboardWorkerController,
  DashboardSettingsController,
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
  settingsController?: DashboardSettingsController;
  projectDurability?: DashboardDurabilityProjector;
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
  /** Must explicitly authorize every dashboard, RPC, and asset request. */
  authorize?: (
    request: Request,
  ) => boolean | DashboardPrincipal | Response | Promise<boolean | DashboardPrincipal | Response>;
  /** Standalone single-administrator credentials. Mutually exclusive with `authorize`. */
  singleAdmin?: DashboardSingleAdminOptions;
}

/** Identity established by the embedded application's server-side authorization boundary. */
export interface DashboardPrincipal {
  actor: string;
}

export interface DashboardHost {
  /** Normalized mount path. Empty string when the dashboard owns the host root. */
  readonly basePath: string;
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

const SLOW_RPC_REQUEST_MS = 1_000;
const rpcLogRecords = {
  completed: {
    severityNumber: SeverityNumber.DEBUG,
    severityText: "DEBUG",
    eventName: "workhorse.dashboard.rpc_completed",
    body: "Dashboard RPC request completed",
  },
  slow: {
    severityNumber: SeverityNumber.WARN,
    severityText: "WARN",
    eventName: "workhorse.dashboard.rpc_completed",
    body: "Dashboard RPC request completed slowly",
  },
  failed: {
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    eventName: "workhorse.dashboard.rpc_failed",
    body: "Dashboard RPC request failed",
  },
} as const;

function logRpcRequest(procedure: string, durationMs: number, statusCode: number): void {
  const record =
    statusCode >= 400
      ? rpcLogRecords.failed
      : durationMs >= SLOW_RPC_REQUEST_MS
        ? rpcLogRecords.slow
        : rpcLogRecords.completed;
  logs.getLogger("@workhorse/dashboard").emit({
    ...record,
    attributes: {
      "rpc.system": "orpc",
      "rpc.method": procedure,
      "http.response.status_code": statusCode,
      "workhorse.dashboard.rpc.duration_ms": durationMs,
    },
  });
}

function rpcProcedure(pathname: string, prefix: string): string {
  return pathname.slice(prefix.length).split("/").filter(Boolean).join(".");
}

function rejectCrossOriginMutation(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin === new URL(request.url).origin) return null;
    } catch {
      // A malformed Origin is never evidence that the request came from this dashboard.
    }
  }
  return Response.json({ error: "A same-origin mutation request is required" }, { status: 403 });
}

/**
 * Build a framework-neutral Workhorse dashboard request handler.
 *
 * The returned host serves the packaged React application, its private oRPC endpoint, and static
 * assets over standard `Request`/`Response` objects. It deliberately
 * never installs or migrates schema; it only asserts that the installed schema is compatible.
 *
 * Framework integration packages are expected to be thin: route every request under `basePath`
 * into `handle`, and fall through to their own routing when it resolves to `null`.
 */
export function createDashboardHost(options: DashboardHostOptions): DashboardHost {
  if (Boolean(options.authorize) === Boolean(options.singleAdmin)) {
    throw new TypeError("Configure exactly one dashboard authorization mode");
  }
  const path = normalizeDashboardPath(options.path ?? "/workhorse");
  const singleAdmin = options.singleAdmin
    ? createSingleAdminAuthentication(options.singleAdmin)
    : undefined;
  const assets = dashboardAssetsDirectory();
  const rpc = new RPCHandler(dashboardRouter);
  const database = dashboardDatabase(options.database);
  // The read model needs a Queue only for `health()`, which reads through the same connection and
  // does not depend on a default queue name, so there is nothing for a caller to supply here.
  const queue = new Queue(options.database);
  let compatibility: Promise<void> | undefined;

  const owns = (pathname: string): boolean =>
    path === "" || pathname === path || pathname.startsWith(`${path}/`);

  async function serveApplication(url: URL, authenticatedActor: string): Promise<Response> {
    const template = options.dev
      ? await options.dev.readTemplate()
      : await readFile(join(assets, "index.html"), "utf8");
    const rendered = renderDashboardHtml(template, {
      runtime: {
        basePath: path,
        rpcUrl: `${path}/rpc`,
        auditActor: authenticatedActor,
        authentication: singleAdmin
          ? { loginUrl: `${path}/login`, logoutUrl: `${path}/logout` }
          : null,
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

  return {
    basePath: path,
    owns(request) {
      return owns(new URL(request.url).pathname);
    },
    async handle(request) {
      const url = new URL(request.url);
      const pathname = url.pathname;
      if (!owns(pathname)) return null;

      const authenticationResponse = await singleAdmin?.handle(
        request,
        `${path}/login`,
        `${path}/logout`,
      );
      if (authenticationResponse) return authenticationResponse;

      const authorization = options.authorize
        ? await options.authorize(request)
        : (singleAdmin?.authorize(request, path) ?? false);
      if (authorization instanceof Response) return authorization;
      if (!authorization) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      const authenticatedActor =
        typeof authorization === "object"
          ? authorization.actor
          : (options.auditActor ?? "dashboard");

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
        const rpcPrefix = `${path}/rpc`;
        const procedure = rpcProcedure(pathname, rpcPrefix);
        if (isDashboardMutation(procedure)) {
          const rejection = rejectCrossOriginMutation(request);
          if (rejection) return rejection;
        }
        const startedAt = performance.now();
        const { response } = await rpc.handle(request, {
          prefix: rpcPrefix as `/${string}`,
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
            settingsController: options.settingsController,
            projectDurability: options.projectDurability,
            authenticatedActor,
          },
        });
        if (response) {
          logRpcRequest(procedure, performance.now() - startedAt, response.status);
        }
        return response ?? null;
      }

      if (pathname.startsWith(`${path}/assets/`)) return serveAsset(pathname);

      if (pathname === (path || "/")) {
        // A relative Location keeps the redirect correct behind proxies that rewrite the host or
        // terminate TLS, which an absolute URL built from the inbound request would not.
        return new Response(null, { status: 302, headers: { location: `${path}/tasks` } });
      }

      return serveApplication(url, authenticatedActor);
    },
  };
}
