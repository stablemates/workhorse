import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { DashboardClient } from "./client.js";
import type { DashboardRouter } from "./server/router.js";

/** Create the browser client used by the packaged dashboard application. */
export function createDashboardClient(rpcUrl: string): DashboardClient {
  const link = new RPCLink({ url: () => new URL(rpcUrl, window.location.origin) });
  return createORPCClient<RouterClient<DashboardRouter>>(link).dashboard;
}
