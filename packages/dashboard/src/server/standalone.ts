import { createServer } from "node:http";
import type { DashboardStandaloneModule } from "@workhorse/dashboard-contract";
import { Queue, type Queryable } from "@workhorse/core";
import { createDashboardHost } from "./host.js";
import { dashboardNodeMiddleware } from "./node.js";
import { createDashboardOperatorControllers } from "./operator-controllers.js";

/**
 * Serve the operator dashboard as its own process against any Workhorse database.
 *
 * The caller owns the database connection and its shutdown. This module owns the HTTP listener and
 * the dashboard implementation, so core only depends on the small standalone contract.
 */
export const startDashboardServer: DashboardStandaloneModule<Queryable>["startDashboardServer"] =
  async (database, options) => {
    const queue = new Queue(database);
    const controls = options.allowMutations
      ? createDashboardOperatorControllers({
          requestedBy: options.actor,
          run: (_action, operation) => operation(queue),
        })
      : { operator: { mode: "read-only" as const } };

    const host = createDashboardHost({
      database,
      path: "/",
      environment: "standalone",
      auditActor: options.actor,
      ...(options.authentication
        ? { singleAdmin: options.authentication }
        : {
            // The missing credential mode is an explicit local development bypass. The CLI keeps
            // it on loopback unless an operator deliberately widens the listener.
            authorize: () => true,
          }),
      ...controls,
    });

    const middleware = dashboardNodeMiddleware(host);
    const server = createServer((request, response) => {
      middleware(request, response, () => {
        response.statusCode = 404;
        response.end("Not found");
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.hostname, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port;
    return {
      url: `http://${options.hostname}:${port}`,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
  };
