import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { DashboardRouter } from "../../src/rpc";

const link = new RPCLink({
  url: () => new URL("/rpc", window.location.origin),
});

export const rpcClient: RouterClient<DashboardRouter> = createORPCClient(link);
