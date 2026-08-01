import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { RPCHandler } from "@orpc/server/fetch";
import { assertSchemaCompatible } from "@workhorse/core";
import {
  DashboardRefreshHub,
  dashboardAssetsDirectory,
  dashboardDatabase,
  dashboardRouter,
  type DashboardDurabilityProjector,
  type DashboardOperator,
  type DashboardQueueController,
  type DashboardScheduleController,
  type DashboardTaskController,
  type DashboardWorkerController,
} from "@workhorse/dashboard/server";
import type { Env, Hono, MiddlewareHandler, Schema } from "hono";
import { streamSSE } from "hono/streaming";
import type { HonoWorkhorse } from "./index.js";

export interface MountWorkhorseDashboardOptions<TTransaction> {
  workhorse: HonoWorkhorse<TTransaction>;
  /** URL namespace. Defaults to `/workhorse`. */
  path?: string;
  environment?: string;
  configuredWorkers?: readonly string[];
  maintenanceLoops?: { tickIntervalMs: number; housekeepingIntervalMs: number };
  operator?: DashboardOperator;
  scheduleController?: DashboardScheduleController;
  queueController?: DashboardQueueController;
  taskController?: DashboardTaskController;
  workerController?: DashboardWorkerController;
  projectDurability?: DashboardDurabilityProjector;
  refresh?: DashboardRefreshHub;
  auditActor?: string;
  /** Must explicitly authorize every dashboard, RPC, asset, and event-stream request. */
  authorize(request: Request): boolean | Response | Promise<boolean | Response>;
}

function mountPath(input: string): string {
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

/**
 * Mount the complete Workhorse admin application into an existing Hono app.
 *
 * This serves the packaged React application, oRPC endpoint, and SSE refresh stream. It checks the
 * installed schema but deliberately never installs or migrates it.
 */
export function mountWorkhorseDashboard<
  TTransaction,
  TEnvironment extends Env,
  TSchema extends Schema,
  TBasePath extends string,
>(
  app: Hono<TEnvironment, TSchema, TBasePath>,
  options: MountWorkhorseDashboardOptions<TTransaction>,
): DashboardRefreshHub {
  const path = mountPath(options.path ?? "/workhorse");
  if (!path) throw new Error("Workhorse dashboard must be mounted below a non-root namespace");
  const assets = dashboardAssetsDirectory();
  const refresh = options.refresh ?? new DashboardRefreshHub();
  const rpc = new RPCHandler(dashboardRouter);
  const database = dashboardDatabase(options.workhorse.database);
  let compatibility: Promise<void> | undefined;

  const protect: MiddlewareHandler<TEnvironment> = async (context, next) => {
    const authorization = await options.authorize(context.req.raw);
    if (authorization instanceof Response) return authorization;
    if (!authorization) return context.json({ error: "Forbidden" }, 403);
    compatibility ??= assertSchemaCompatible(options.workhorse.database);
    try {
      await compatibility;
    } catch (error) {
      compatibility = undefined;
      return context.json(
        { error: error instanceof Error ? error.message : "Incompatible Workhorse schema" },
        503,
      );
    }
    await next();
  };
  app.use(path, protect);
  app.use(`${path}/*`, protect);

  app.all(`${path}/rpc/*`, async (context) => {
    const { response } = await rpc.handle(context.req.raw, {
      prefix: `${path}/rpc` as `/${string}`,
      context: {
        database,
        queue: options.workhorse.context.queue,
        configuredWorkers: options.configuredWorkers ?? [],
        environment: options.environment ?? "unknown",
        maintenanceLoops: options.maintenanceLoops ?? {
          tickIntervalMs: 1_000,
          housekeepingIntervalMs: 60_000,
        },
        operator: options.operator ?? { mode: "read-only" },
        scheduleController: options.scheduleController,
        queueController: options.queueController,
        taskController: options.taskController,
        workerController: options.workerController,
        projectDurability: options.projectDurability,
      },
    });
    return response ?? context.notFound();
  });

  app.get(`${path}/events`, (context) =>
    streamSSE(context, async (stream) => {
      let writes = Promise.resolve();
      const publish = (event: { reason: string; occurredAt: string }) => {
        writes = writes.then(() =>
          stream.writeSSE({ event: "refresh", data: JSON.stringify(event) }),
        );
      };
      const unsubscribe = refresh.subscribe(publish);
      const fallback = setInterval(
        () => publish({ reason: "fallback", occurredAt: new Date().toISOString() }),
        15_000,
      );
      fallback.unref();
      publish({ reason: "connected", occurredAt: new Date().toISOString() });
      try {
        await new Promise<void>((resolve) => {
          context.req.raw.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        clearInterval(fallback);
        unsubscribe();
        await writes.catch(() => undefined);
      }
    }),
  );

  app.get(`${path}/assets/*`, async (context) => {
    const relative = context.req.path.slice(`${path}/`.length);
    const safe = normalize(relative).replaceAll("\\", "/");
    if (!safe.startsWith("assets/") || safe.includes("../")) return context.notFound();
    try {
      const body = await readFile(join(assets, safe));
      return new Response(body, {
        headers: {
          "content-type": contentTypes[extname(safe)] ?? "application/octet-stream",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return context.notFound();
    }
  });

  const serveApplication = async () => {
    const template = await readFile(join(assets, "index.html"), "utf8");
    const runtime = {
      basePath: path,
      rpcUrl: `${path}/rpc`,
      eventsUrl: `${path}/events`,
      auditActor: options.auditActor ?? "dashboard",
      demoTools: Boolean(options.operator?.enqueueTest),
    };
    return new Response(
      template.replace(
        "/*__WORKHORSE_RUNTIME_CONFIG__*/",
        `window.workhorseDashboard=${JSON.stringify(runtime).replaceAll("<", "\\u003c")}`,
      ),
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
  };
  app.get(path, (context) => context.redirect(`${path}/tasks`));
  app.get(`${path}/*`, serveApplication);

  return refresh;
}
