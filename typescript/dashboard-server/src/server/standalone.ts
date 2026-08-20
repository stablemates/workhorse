import { createServer } from "node:http";
import { isIP } from "node:net";
import type { DashboardStandaloneModule } from "@workhorse-js/dashboard-contract";
import { Queue, type Queryable } from "@workhorse-js/core";
import { createDashboardHost } from "./host.js";
import { dashboardNodeMiddleware, normalizeDashboardPublicOrigin } from "./node.js";
import { createDashboardOperatorControllers } from "./operator-controllers.js";

/**
 * Serve the operator dashboard as its own process against any Workhorse database.
 *
 * The caller owns the database connection and its shutdown. This module owns the HTTP listener and
 * the dashboard implementation, so core only depends on the small standalone contract.
 */
function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  if (family === 4) return normalized.startsWith("127.");
  return family === 6 && normalized === "::1";
}

export const startDashboardServer: DashboardStandaloneModule<Queryable>["startDashboardServer"] =
  async (database, options) => {
    const publicOrigin = options.publicOrigin
      ? normalizeDashboardPublicOrigin(options.publicOrigin)
      : undefined;
    const tcpListener = !options.socketPath;
    const loopbackListener = tcpListener && isLoopbackHostname(options.hostname);
    if (!options.authentication && tcpListener && !loopbackListener) {
      throw new TypeError(
        "The unauthenticated dashboard development bypass requires a loopback listener or Unix socket",
      );
    }
    if (publicOrigin) {
      const origin = new URL(publicOrigin);
      if (!options.authentication && !isLoopbackHostname(origin.hostname)) {
        throw new TypeError(
          "The unauthenticated dashboard development bypass cannot use a remote public origin",
        );
      }
      if (
        origin.protocol !== "https:" &&
        (!isLoopbackHostname(origin.hostname) || (tcpListener && !loopbackListener))
      ) {
        throw new TypeError("A remote dashboard requires an HTTPS public origin");
      }
    }
    if (options.authentication && tcpListener && !loopbackListener && !publicOrigin) {
      throw new TypeError(
        "An authenticated remote dashboard requires an explicit HTTPS public origin",
      );
    }
    // Each database gets its own Queue so mutations in one workspace can never reach another.
    const workspaceControls = (workspaceDatabase: Queryable) => {
      const queue = new Queue(workspaceDatabase);
      return options.allowMutations
        ? createDashboardOperatorControllers({
            run: (_action, operation) => operation(queue),
          })
        : { operator: { mode: "read-only" as const } };
    };
    const workspaceTarget =
      typeof database === "object" && database !== null && "workspaces" in database
        ? database
        : undefined;

    const host = createDashboardHost({
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
      ...(workspaceTarget
        ? {
            workspaces: Object.fromEntries(
              Object.entries(workspaceTarget.workspaces).map(([name, workspaceDatabase]) => [
                name,
                { database: workspaceDatabase, ...workspaceControls(workspaceDatabase) },
              ]),
            ),
            defaultWorkspace: workspaceTarget.defaultWorkspace,
          }
        : { database: database as Queryable, ...workspaceControls(database as Queryable) }),
    });

    const middleware = dashboardNodeMiddleware(host, { publicOrigin });
    const server = createServer((request, response) => {
      middleware(request, response, () => {
        response.statusCode = 404;
        response.end("Not found");
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      const onListening = (): void => {
        server.removeListener("error", reject);
        resolve();
      };
      if (options.socketPath) server.listen(options.socketPath, onListening);
      else server.listen(options.port, options.hostname, onListening);
    });

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port;
    return {
      url:
        publicOrigin ??
        (options.socketPath
          ? `unix://${options.socketPath}`
          : `http://${options.hostname}:${port}`),
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
  };
