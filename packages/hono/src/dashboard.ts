import { createDashboardHost, type DashboardHostOptions } from "@workhorse/dashboard/server";
import type { Env, Hono, Schema } from "hono";

export type MountWorkhorseDashboardOptions = DashboardHostOptions;

/**
 * Mount the complete Workhorse admin application into an existing Hono app.
 *
 * All dashboard behavior lives in the framework-neutral host from `@workhorse/dashboard/server`.
 * This function only maps the host's mount path onto Hono routes and falls through to the
 * application's own routing when the host does not own a request.
 */
export function mountWorkhorseDashboard<
  TEnvironment extends Env,
  TSchema extends Schema,
  TBasePath extends string,
>(app: Hono<TEnvironment, TSchema, TBasePath>, options: MountWorkhorseDashboardOptions): void {
  const host = createDashboardHost(options);
  const routes = host.basePath ? [host.basePath, `${host.basePath}/*`] : ["*"];

  for (const route of routes) {
    app.all(route, async (context) => (await host.handle(context.req.raw)) ?? context.notFound());
  }
}
