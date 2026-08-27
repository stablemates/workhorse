import { readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { SeverityNumber, logs } from "@opentelemetry/api-logs";
import { RPCHandler } from "@orpc/server/fetch";
import type { DashboardSingleAdminOptions } from "@stablemates/workhorse-dashboard-contract";
import { Admin, assertSchemaCompatible, Queue, type Queryable } from "@stablemates/workhorse";
import type { MaintenanceLoopCadences } from "../wire.js";
import { dashboardAssetsDirectory } from "./assets.js";
import { createSingleAdminAuthentication } from "./authentication.js";
import { renderDashboardHtml } from "./html.js";
import { dashboardRouter, isDashboardMutation } from "./router.js";
import { createDashboardQueueHealthReader, type DashboardQueueHealthReader } from "./read-model.js";
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
import type { DashboardWorkspaceLink } from "../runtime-config.js";

export interface DashboardHostOptions {
  /**
   * Any Workhorse-compatible connection. The host never installs or migrates schema.
   *
   * The dashboard is a guest in the caller's process and deliberately does not accept a connection
   * string: it must not own pool sizing, shutdown ordering, reconnection, or TLS for an application
   * that already has a connection. Accepting a `Queryable` also keeps the package driver-agnostic
   * and free of a `pg` dependency, and works for deployments that have no URL at all, such as IAM
   * token auth, unix sockets, or dynamically issued credentials.
   *
   * Configure exactly one of `database` and `workspaces`. `database` is single-workspace mode: the
   * dashboard serves one unnamed database directly under `path`, exactly as it did before
   * workspaces existed.
   */
  database?: Queryable;
  /**
   * Named workspaces, each backed by its own database, switchable in the served application.
   *
   * Every workspace mounts under its own path segment: `${path}/${name}` serves the application
   * and `${path}/${name}/rpc` its endpoint, while `path` itself redirects to `defaultWorkspace`.
   * Workspace values carry the same `Queryable` contract as `database`; the host still never owns
   * pool sizing, shutdown ordering, reconnection, or TLS. Host-level controller, environment, and
   * cadence options act as defaults that each workspace may override.
   */
  workspaces?: Readonly<Record<string, DashboardWorkspaceOptions>>;
  /** Workspace served at `path`. Defaults to the first configured workspace. */
  defaultWorkspace?: string;
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
   * Supply `createDashboardDevServer()` from `@stablemates/workhorse-dashboard/dev` in development. The HTML
   * still goes through this host and the same `renderDashboardHtml` contract; only the module
   * source changes, which is what makes one origin able to hot-reload without a second server.
   */
  dev?: {
    readTemplate(): Promise<string>;
    transformHtml(url: string, html: string): Promise<string>;
  };
  /**
   * Must explicitly authorize every dashboard, RPC, and asset request.
   *
   * `workspace` is the workspace the request resolved to, so an embedding application can grant
   * access per workspace. It is null in single-workspace mode and for requests outside any
   * workspace, such as the redirect from `path` to the default workspace.
   */
  authorize?: (
    request: Request,
    workspace: string | null,
  ) => boolean | DashboardPrincipal | Response | Promise<boolean | DashboardPrincipal | Response>;
  /** Standalone single-administrator credentials. Mutually exclusive with `authorize`. */
  singleAdmin?: DashboardSingleAdminOptions;
}

/** One named workspace served by a dashboard host. See `DashboardHostOptions.workspaces`. */
export interface DashboardWorkspaceOptions {
  /** This workspace's connection, under the same ownership contract as `DashboardHostOptions.database`. */
  database: Queryable;
  /**
   * Display-only label of the backing database host, shown in the workspace switcher.
   *
   * The host never derives it: a `Queryable` carries no address, and deployments without one —
   * unix sockets, IAM tokens — still deserve a truthful label the embedder controls.
   */
  databaseHost?: string;
  /** Display-only name of the backing database, under the same contract as `databaseHost`. */
  databaseName?: string;
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

/** Path segments the host routes itself, which a workspace name must therefore never shadow. */
const RESERVED_WORKSPACE_NAMES = new Set(["rpc", "assets", "login", "logout"]);

const WORKSPACE_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/i;

/** A resolved workspace with its own connection, queue, and request context. */
interface HostWorkspace {
  admin: Admin;
  name: string | null;
  basePath: string;
  databaseHost: string | undefined;
  databaseName: string | undefined;
  queryable: Queryable;
  database: ReturnType<typeof dashboardDatabase>;
  queue: Queue;
  environment: string;
  configuredWorkers: readonly string[];
  maintenanceLoops: MaintenanceLoopCadences;
  operator: DashboardOperator;
  scheduleController?: DashboardScheduleController;
  queueController?: DashboardQueueController;
  taskController?: DashboardTaskController;
  workerController?: DashboardWorkerController;
  settingsController?: DashboardSettingsController;
  projectDurability?: DashboardDurabilityProjector;
  readQueueHealth: DashboardQueueHealthReader;
  compatibility?: Promise<void>;
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

function logRpcRequest(
  procedure: string,
  durationMs: number,
  statusCode: number,
  workspace: string | null,
): void {
  const record =
    statusCode >= 400
      ? rpcLogRecords.failed
      : durationMs >= SLOW_RPC_REQUEST_MS
        ? rpcLogRecords.slow
        : rpcLogRecords.completed;
  logs.getLogger("@stablemates/workhorse-dashboard").emit({
    ...record,
    attributes: {
      "rpc.system": "orpc",
      "rpc.method": procedure,
      "http.response.status_code": statusCode,
      "workhorse.dashboard.rpc.duration_ms": durationMs,
      // Single-workspace mode has no name; omitting the attribute keeps its records unchanged.
      ...(workspace === null ? {} : { "workhorse.dashboard.workspace": workspace }),
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
  if (Boolean(options.database) === Boolean(options.workspaces)) {
    throw new TypeError("Configure exactly one of a dashboard database or dashboard workspaces");
  }
  const path = normalizeDashboardPath(options.path ?? "/workhorse");
  const assets = dashboardAssetsDirectory();
  const singleAdmin = options.singleAdmin
    ? createSingleAdminAuthentication(
        options.singleAdmin,
        readFileSync(join(assets, "login.html"), "utf8"),
      )
    : undefined;
  const rpc = new RPCHandler(dashboardRouter);

  const resolveWorkspace = (
    name: string | null,
    workspace: DashboardWorkspaceOptions,
  ): HostWorkspace => {
    const database = dashboardDatabase(workspace.database);
    return {
      name,
      basePath: name === null ? path : `${path}/${name}`,
      databaseHost: workspace.databaseHost,
      databaseName: workspace.databaseName,
      queryable: workspace.database,
      database,
      // Administrative policy and wait reads share the dashboard's caller-owned connection.
      admin: new Admin(workspace.database),
      queue: new Queue(workspace.database),
      environment: workspace.environment ?? options.environment ?? "unknown",
      configuredWorkers: workspace.configuredWorkers ?? options.configuredWorkers ?? [],
      maintenanceLoops: workspace.maintenanceLoops ??
        options.maintenanceLoops ?? { tickIntervalMs: 1_000 },
      operator: workspace.operator ?? options.operator ?? { mode: "read-only" },
      scheduleController: workspace.scheduleController ?? options.scheduleController,
      queueController: workspace.queueController ?? options.queueController,
      taskController: workspace.taskController ?? options.taskController,
      workerController: workspace.workerController ?? options.workerController,
      settingsController: workspace.settingsController ?? options.settingsController,
      projectDurability: workspace.projectDurability ?? options.projectDurability,
      readQueueHealth: createDashboardQueueHealthReader(database),
    };
  };

  const workspaces = new Map<string, HostWorkspace>();
  for (const [name, workspace] of Object.entries(options.workspaces ?? {})) {
    if (!WORKSPACE_NAME.test(name) || RESERVED_WORKSPACE_NAMES.has(name.toLowerCase())) {
      throw new TypeError(`Invalid dashboard workspace name: ${JSON.stringify(name)}`);
    }
    workspaces.set(name, resolveWorkspace(name, workspace));
  }
  if (options.workspaces && workspaces.size === 0) {
    throw new TypeError("Configure at least one dashboard workspace");
  }
  const defaultWorkspaceName = options.defaultWorkspace ?? workspaces.keys().next().value ?? "";
  if (workspaces.size > 0 && !workspaces.has(defaultWorkspaceName)) {
    throw new TypeError(`Unknown default dashboard workspace: ${String(options.defaultWorkspace)}`);
  }
  const single = options.database
    ? resolveWorkspace(null, { ...options, database: options.database })
    : undefined;
  const workspaceLinks = [...workspaces.values()].map((workspace) => {
    const link: DashboardWorkspaceLink = {
      name: workspace.name as string,
      url: workspace.basePath,
    };
    if (workspace.databaseHost !== undefined) link.databaseHost = workspace.databaseHost;
    if (workspace.databaseName !== undefined) link.databaseName = workspace.databaseName;
    return link;
  });
  if (workspaces.size > 0) {
    logs.getLogger("@stablemates/workhorse-dashboard").emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      eventName: "workhorse.dashboard.workspaces_configured",
      body: "Dashboard host serves named workspaces",
      attributes: {
        "workhorse.dashboard.workspace_count": workspaces.size,
        "workhorse.dashboard.workspace_names": [...workspaces.keys()],
        "workhorse.dashboard.default_workspace": defaultWorkspaceName,
      },
    });
  }

  const owns = (pathname: string): boolean =>
    path === "" || pathname === path || pathname.startsWith(`${path}/`);

  async function serveApplication(
    url: URL,
    authenticatedActor: string,
    workspace: HostWorkspace,
  ): Promise<Response> {
    const template = options.dev
      ? await options.dev.readTemplate()
      : await readFileAsync(join(assets, "index.html"), "utf8");
    const rendered = renderDashboardHtml(template, {
      runtime: {
        basePath: workspace.basePath,
        rpcUrl: `${workspace.basePath}/rpc`,
        auditActor: authenticatedActor,
        authentication: singleAdmin
          ? { loginUrl: `${path}/login`, logoutUrl: `${path}/logout` }
          : null,
        demoTools: Boolean(workspace.operator.enqueueTest),
        workspaces: workspaceLinks,
        workspace: workspace.name,
      },
      browserModules: options.browserModules,
    });
    const html = options.dev ? await options.dev.transformHtml(url.pathname, rendered) : rendered;
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  async function serveAsset(pathname: string, basePath: string): Promise<Response | null> {
    const relative = pathname.slice(`${basePath}/`.length);
    const safe = normalize(relative).replaceAll("\\", "/");
    if (!safe.startsWith("assets/") || safe.includes("../")) return null;
    try {
      const body = await readFileAsync(join(assets, safe));
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

      // Workspace resolution is pure path parsing, so it happens before authorization to give the
      // authorize callback the workspace name; it must never read from a database.
      let workspace = single;
      if (!workspace) {
        const segment = pathname.slice(path.length).split("/")[1] ?? "";
        workspace = workspaces.get(segment);
      }

      const authorization = options.authorize
        ? await options.authorize(request, workspace?.name ?? null)
        : (singleAdmin?.authorize(request, path) ?? false);
      if (authorization instanceof Response) return authorization;
      if (!authorization) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      const authenticatedActor =
        typeof authorization === "object"
          ? authorization.actor
          : (options.auditActor ?? "dashboard");

      if (!workspace) {
        if (pathname === (path || "/") || pathname === `${path}/`) {
          // A relative Location keeps the redirect correct behind proxies that rewrite the host
          // or terminate TLS, which an absolute URL built from the inbound request would not.
          return new Response(null, {
            status: 302,
            headers: { location: `${path}/${defaultWorkspaceName}/tasks` },
          });
        }
        return Response.json({ error: "Unknown dashboard workspace" }, { status: 404 });
      }
      const basePath = workspace.basePath;

      workspace.compatibility ??= assertSchemaCompatible(workspace.queryable);
      try {
        await workspace.compatibility;
      } catch (error) {
        workspace.compatibility = undefined;
        return Response.json(
          { error: error instanceof Error ? error.message : "Incompatible Workhorse schema" },
          { status: 503 },
        );
      }

      if (pathname === `${basePath}/rpc` || pathname.startsWith(`${basePath}/rpc/`)) {
        const rpcPrefix = `${basePath}/rpc`;
        const procedure = rpcProcedure(pathname, rpcPrefix);
        if (isDashboardMutation(procedure)) {
          const rejection = rejectCrossOriginMutation(request);
          if (rejection) return rejection;
        }
        const startedAt = performance.now();
        const { response } = await rpc.handle(request, {
          prefix: rpcPrefix as `/${string}`,
          context: {
            admin: workspace.admin,
            database: workspace.database,
            queue: workspace.queue,
            configuredWorkers: workspace.configuredWorkers,
            environment: workspace.environment,
            maintenanceLoops: workspace.maintenanceLoops,
            operator: workspace.operator,
            scheduleController: workspace.scheduleController,
            queueController: workspace.queueController,
            taskController: workspace.taskController,
            workerController: workspace.workerController,
            settingsController: workspace.settingsController,
            projectDurability: workspace.projectDurability,
            authenticatedActor,
            readQueueHealth: workspace.readQueueHealth,
          },
        });
        if (response) {
          logRpcRequest(procedure, performance.now() - startedAt, response.status, workspace.name);
        }
        return response ?? null;
      }

      if (pathname.startsWith(`${basePath}/assets/`)) return serveAsset(pathname, basePath);

      if (pathname === (basePath || "/")) {
        // See the redirect note above; the same proxy constraint applies here.
        return new Response(null, { status: 302, headers: { location: `${basePath}/tasks` } });
      }

      return serveApplication(url, authenticatedActor, workspace);
    },
  };
}
