import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { DashboardClient } from "./client.js";
import type { DashboardRouter } from "./server/router.js";

export type { DashboardAuthenticationRoutes, DashboardWorkspaceLink } from "./runtime-config.js";

export interface DashboardClientOptions {
  /** Mounted login URL for built-in authentication. Omit for host-owned authorization. */
  unauthorizedRedirectUrl?: string;
}

/** Create the browser client used by the packaged dashboard application. */
export function createDashboardClient(
  rpcUrl: string,
  options: DashboardClientOptions = {},
): DashboardClient {
  let redirecting = false;
  const navigationPending = new Promise<Response>(() => undefined);
  const link = new RPCLink({
    url: () => new URL(rpcUrl, window.location.origin),
    fetch: async (request, init) => {
      const response = await globalThis.fetch(request, init);
      if (response.status === 401 && options.unauthorizedRedirectUrl && !redirecting) {
        redirecting = true;
        window.location.replace(options.unauthorizedRedirectUrl);
      }
      if (response.status === 401 && options.unauthorizedRedirectUrl) return navigationPending;
      return response;
    },
  });
  return createORPCClient<RouterClient<DashboardRouter>>(link).dashboard;
}
